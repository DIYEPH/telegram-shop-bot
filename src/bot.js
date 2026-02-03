const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./database');
const sepay = require('./sepay');

const formatPrice = (price) => price.toLocaleString('vi-VN') + ' VND';
const isAdmin = (userId) => config.ADMIN_IDS.includes(userId);
const ORDER_TIMEOUT_MS = 20 * 60 * 1000;

const pendingOrders = new Map();

function generateCode() {
  const existingCodes = new Set([...pendingOrders.values()].map(o => o.content));
  let code;
  let attempts = 0;
  do {
    code = Math.random().toString(36).substring(2, 10).toUpperCase();
    attempts++;
  } while (existingCodes.has(code) && attempts < 100);
  return code;
}

function getQRUrl(amount, content) {
  return `https://img.vietqr.io/image/${config.BANK_BIN}-${config.BANK_ACCOUNT}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(content)}`;
}

async function startBot() {
  await db.initDB();

  const savedOrders = db.getPendingOrders();
  savedOrders.forEach(o => {
    pendingOrders.set(o.id, {
      chatId: o.chatId,
      userId: o.userId,
      productId: o.productId,
      quantity: o.quantity,
      totalPrice: o.totalPrice,
      content: o.content,
      createdAt: o.createdAt
    });
  });
  console.log('📦 Loaded ' + savedOrders.length + ' pending orders từ DB');

  const bot = new TelegramBot(config.BOT_TOKEN, {
    polling: { params: { timeout: 10 }, interval: 300 }
  });

  bot.setMyCommands([
    { command: 'start', description: 'Bắt đầu' },
    { command: 'menu', description: 'Mua hàng' }
  ]);

  // Commands riêng cho ADMIN
  config.ADMIN_IDS.forEach(adminId => {
    bot.setMyCommands([
      { command: 'products', description: '⚙️ Quản lý sản phẩm' },
      { command: 'orders', description: '📦 Xem đơn hàng' },
      { command: 'revenue', description: '📈 Doanh thu' },
      { command: 'users', description: '👥 Danh sách user' },
      { command: 'broadcast', description: '📣 Gửi thông báo' }
    ], { scope: { type: 'chat', chat_id: adminId } });
  });

  bot.on('polling_error', (err) => console.log('Polling error:', err.message));

  setInterval(async () => {
    const now = Date.now();
    for (const [orderId, order] of pendingOrders) {
      if (now - order.createdAt > ORDER_TIMEOUT_MS) {
        pendingOrders.delete(orderId);
        db.updateOrder(orderId, null, 'expired');
        bot.sendMessage(order.chatId, '✖️ Đơn #' + orderId + ' đã hết hạn do không thanh toán trong 20 phút.\n\n⚡ Mua lại? Gõ /menu');
        continue;
      }
      const paid = await sepay.checkPayment(order.content, order.totalPrice);
      if (paid) {
        // Xóa NGAY để tránh xử lý trùng
        pendingOrders.delete(orderId);

        const product = db.getProduct(order.productId);
        let accounts = [];
        for (let i = 0; i < order.quantity; i++) {
          const stock = db.getAvailableStock(order.productId);
          if (stock) { db.markStockSold(stock.id, order.userId); accounts.push(stock.account_data); }
        }
        if (accounts.length > 0) {
          db.updateOrder(orderId, null, 'completed');
          let accText = accounts.map((a, idx) => (idx + 1) + '. ' + a).join('\n');
          bot.sendMessage(order.chatId, '🎯 Thanh toán thành công!\n\n📦 ' + product.name + ' x' + order.quantity + '\n\n🔑 Tài khoản:\n' + accText + '\n\n⚡ Mua thêm? Gõ /menu');
          config.ADMIN_IDS.forEach(id => bot.sendMessage(id, '🔔 Đơn #' + orderId + ' ĐÃ THANH TOÁN\n◉ User: ' + order.userId + '\n📦 ' + product.name + ' x' + order.quantity + '\n💵 ' + formatPrice(order.totalPrice)));
        }
      }
    }
  }, 30000);

  const showMainMenu = (chatId, firstName, messageId = null) => {
    const keyboard = [
      [{ text: '⚡ Mua hàng                              ', callback_data: 'main_shop' }],
      [{ text: '🔐 Hồ sơ', callback_data: 'main_profile' }, { text: '📦 Lịch sử mua', callback_data: 'main_history' }]
    ];
    const text = '⚙️ Menu chính\n\n◉ Họ tên: ' + firstName + '\n◉ Plan: BUYER';
    if (messageId) {
      bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    } else {
      bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    }
  };

  bot.onText(/\/start/, (msg) => {
    db.saveUser(msg.from.id, msg.from.first_name, msg.from.username || '');
    showMainMenu(msg.chat.id, msg.from.first_name);
  });

  bot.onText(/\/menu/, (msg) => {
    db.saveUser(msg.from.id, msg.from.first_name, msg.from.username || '');
    showMainMenu(msg.chat.id, msg.from.first_name);
  });

  bot.onText(/\/myid/, (msg) => {
    bot.sendMessage(msg.chat.id, '🔖 User ID: ' + msg.from.id);
  });

  // /clear - Xóa tin nhắn (chỉ admin)
  bot.onText(/\/clear/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const chatId = msg.chat.id;
    let deleted = 0;

    bot.sendMessage(chatId, '⏳ Đang xóa tin nhắn...').then(async (sentMsg) => {
      for (let i = msg.message_id; i > msg.message_id - 50; i--) {
        try {
          await bot.deleteMessage(chatId, i);
          deleted++;
        } catch (e) { }
      }
      try { await bot.deleteMessage(chatId, sentMsg.message_id); } catch (e) { }
      bot.sendMessage(chatId, '🎯 Đã xóa ' + deleted + ' tin nhắn!').then(m => {
        setTimeout(() => { try { bot.deleteMessage(chatId, m.message_id); } catch (e) { } }, 3000);
      });
    });
  });

  bot.onText(/\/help/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id,
      '📖 HƯỚNG DẪN SỬ DỤNG BOT ADMIN\n\n' +
      '▸ QUẢN LÝ SẢN PHẨM\n' +
      '/addproduct tên|giá|mô tả - Thêm sản phẩm\n' +
      '/editproduct id|tên|giá|mô tả - Sửa sản phẩm\n' +
      '/deleteproduct id - Xóa sản phẩm\n' +
      '/addstock id - Thêm tài khoản vào kho\n' +
      '/viewstock id - Xem kho sản phẩm\n\n' +
      '▸ THỐNG KÊ\n' +
      '/stats - Xem tồn kho\n' +
      '/revenue - Xem doanh thu\n' +
      '/orders - Xem đơn hàng gần đây\n\n' +
      '▸ QUẢN LÝ USER\n' +
      '/users - Danh sách người dùng\n' +
      '/broadcast tin nhắn - Gửi thông báo'
    );
  });


  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    try {
      if (data === 'main_shop') {
        const products = db.getAllProducts();
        if (products.length === 0) return bot.answerCallbackQuery(query.id, { text: '📦 Chưa có sản phẩm!' });
        const keyboard = products.map(p => [{ text: p.name + ' | ' + formatPrice(p.price) + ' | 📦 ' + p.stock_count, callback_data: 'product_' + p.id }]);
        keyboard.push([{ text: '← Quay lại                              ', callback_data: 'back_main' }]);
        bot.editMessageText('⚡ Chọn sản phẩm:', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
      }

      if (data === 'main_profile') {
        const orders = db.getOrdersByUser(userId);
        const completed = orders.filter(o => o.status === 'completed');
        const totalSpent = completed.reduce((sum, o) => sum + o.price, 0);
        const text = '🔐 Hồ sơ của bạn\n\n◉ User ID: ' + userId + '\n◉ Tên: ' + query.from.first_name + '\n◉ Username: ' + (query.from.username ? '@' + query.from.username : 'Chưa có') + '\n\n▸ Thống kê:\n◉ Đơn hàng: ' + completed.length + '\n◉ Đã chi: ' + formatPrice(totalSpent);
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '← Quay lại                              ', callback_data: 'back_main' }]] } });
      }

      if (data === 'main_history') {
        const orders = db.getOrderHistory(userId);
        if (orders.length === 0) return bot.answerCallbackQuery(query.id, { text: '📦 Chưa có lịch sử!' });
        let text = '📦 Lịch sử mua hàng:\n\n';
        orders.slice(0, 10).forEach(o => {
          text += (o.status === 'completed' ? '🎯' : '⏳') + ' Đơn #' + o.id + '\n';
          text += '◉ ' + o.product_name + '\n';
          text += '◉ ' + formatPrice(o.price) + '\n';
          if (o.account_data && o.status === 'completed') {
            text += '🔑 ' + o.account_data + '\n';
          }
          text += '\n';
        });
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '← Quay lại                              ', callback_data: 'back_main' }]] } });
      }

      if (data === 'back_main') {
        showMainMenu(chatId, query.from.first_name, query.message.message_id);
      }

      if (data.startsWith('product_')) {
        const product = db.getProduct(parseInt(data.split('_')[1]));
        if (!product) return bot.answerCallbackQuery(query.id, { text: 'Không tồn tại!' });
        const maxQty = Math.min(product.stock_count, 5);
        const qtyButtons = [];
        for (let i = 1; i <= maxQty; i++) qtyButtons.push({ text: '' + i, callback_data: 'qty_' + product.id + '_' + i });
        bot.editMessageText('📦 ' + product.name + '\n\n◉ Giá: ' + formatPrice(product.price) + '/sp\n◉ Còn: ' + product.stock_count + ' sp' + (product.description ? '\n\n▸ ' + product.description : '') + '\n\n▸ Chọn số lượng:',
          { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [qtyButtons, [{ text: '← Quay lại                              ', callback_data: 'main_shop' }]] } });
      }

      if (data.startsWith('qty_')) {
        const [, productId, quantity] = data.split('_');
        const product = db.getProduct(parseInt(productId));
        const qty = parseInt(quantity);
        if (product.stock_count < qty) return bot.answerCallbackQuery(query.id, { text: '✖️ Không đủ hàng!' });

        const totalPrice = product.price * qty;
        const content = generateCode();
        const order = db.createOrder(userId, parseInt(productId), chatId, content, qty, totalPrice);
        const orderId = order.lastInsertRowid;
        pendingOrders.set(orderId, { chatId, userId, productId: parseInt(productId), quantity: qty, totalPrice, content, createdAt: order.createdAt });

        await bot.deleteMessage(chatId, query.message.message_id);
        await bot.sendPhoto(chatId, getQRUrl(totalPrice, content), {
          caption: '📄 Đơn hàng #' + orderId + '\n\n◉ ' + product.name + ' x' + qty + '\n◉ Tổng: ' + formatPrice(totalPrice) + '\n\n💳 Chuyển khoản:\n• NH: ' + config.BANK_NAME + '\n• STK: ' + config.BANK_ACCOUNT + '\n• Chủ TK: ' + config.BANK_OWNER + '\n• Nội dung: ' + content + '\n\n📲 Quét QR để thanh toán!\n⏳ Tự động xác nhận khi nhận tiền.\n⚠️ Đơn hết hạn sau 20 phút.',
          reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra thanh toán', callback_data: 'check_' + orderId + '_' + productId + '_' + qty }], [{ text: '✖️ Hủy đơn', callback_data: 'cancel_' + orderId }]] }
        });
        return;
      }

      if (data.startsWith('check_')) {
        const [, orderId, productId, quantity] = data.split('_');
        const order = pendingOrders.get(parseInt(orderId));
        if (!order) return bot.answerCallbackQuery(query.id, { text: '✖️ Đơn hàng không tồn tại hoặc đã xử lý!', show_alert: true });

        const product = db.getProduct(parseInt(productId));
        const qty = parseInt(quantity) || 1;

        const paid = await sepay.checkPayment(order.content, order.totalPrice);
        if (paid) {
          // Xóa NGAY để tránh xử lý trùng
          pendingOrders.delete(parseInt(orderId));

          let accounts = [];
          for (let i = 0; i < qty; i++) {
            const stock = db.getAvailableStock(parseInt(productId));
            if (stock) { db.markStockSold(stock.id, userId); accounts.push(stock.account_data); }
          }
          if (accounts.length > 0) {
            db.updateOrder(parseInt(orderId), null, 'completed');
            let accText = accounts.map((a, idx) => (idx + 1) + '. ' + a).join('\n');
            bot.answerCallbackQuery(query.id, { text: '🎯 Thanh toán thành công!' });
            await bot.sendMessage(chatId, '🎯 Thanh toán thành công!\n\n📦 ' + product.name + ' x' + qty + '\n\n🔑 Tài khoản:\n' + accText + '\n\n⚠️ Đổi mật khẩu ngay!\n\n⚡ Mua thêm? Gõ /menu');
            config.ADMIN_IDS.forEach(id => bot.sendMessage(id, '🔔 Đơn #' + orderId + ' ĐÃ THANH TOÁN\n◉ ' + query.from.first_name + ' (' + userId + ')\n📦 ' + product.name + ' x' + qty + '\n💵 ' + formatPrice(order.totalPrice)));
          }
        } else {
          bot.answerCallbackQuery(query.id, { text: '✖️ Chưa nhận được thanh toán! Thử lại sau.', show_alert: true });
        }
        return;
      }

      if (data.startsWith('cancel_') || data === 'back_menu') {
        // Xóa đơn hàng pending nếu có
        if (data.startsWith('cancel_')) {
          const orderId = parseInt(data.split('_')[1]);
          if (pendingOrders.has(orderId)) {
            pendingOrders.delete(orderId);
            db.updateOrder(orderId, null, 'cancelled');
          }
        }
        const products = db.getAllProducts();
        const keyboard = products.map(p => [{ text: p.name + ' | ' + formatPrice(p.price) + ' | 📦 ' + p.stock_count, callback_data: 'product_' + p.id }]);
        keyboard.push([{ text: '← Quay lại                              ', callback_data: 'back_main' }]);
        if (query.message.photo) {
          await bot.deleteMessage(chatId, query.message.message_id);
          bot.sendMessage(chatId, '⚡ Chọn sản phẩm:', { reply_markup: { inline_keyboard: keyboard } });
        } else {
          bot.editMessageText('⚡ Chọn sản phẩm:', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }
      }

      // ===== ADMIN CALLBACKS =====
      if (data.startsWith('adm_') && isAdmin(userId)) {

        // Xem chi tiết sản phẩm
        if (data.startsWith('adm_product_')) {
          const productId = parseInt(data.split('_')[2]);
          const product = db.getProduct(productId);
          if (!product) return bot.answerCallbackQuery(query.id, { text: '✖️ Không tồn tại!' });
          const stocks = db.getStockByProduct(productId);
          const available = stocks.filter(s => !s.is_sold).length;
          const sold = stocks.length - available;

          const text = '📦 ' + product.name + '\n\n◉ ID: #' + product.id + '\n◉ Giá: ' + formatPrice(product.price) + '\n◉ Mô tả: ' + (product.description || 'Chưa có') + '\n\n📊 Kho hàng:\n◉ Còn: ' + available + '\n◉ Đã bán: ' + sold;
          const keyboard = [
            [{ text: '✏️ Sửa tên', callback_data: 'adm_edit_name_' + productId }, { text: '💵 Sửa giá', callback_data: 'adm_edit_price_' + productId }],
            [{ text: '📝 Sửa mô tả', callback_data: 'adm_edit_desc_' + productId }],
            [{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + productId }, { text: '👁️ Xem stock', callback_data: 'adm_viewstock_' + productId }],
            [{ text: '🗑️ Xóa sản phẩm', callback_data: 'adm_delete_' + productId }],
            [{ text: '← Quay lại', callback_data: 'adm_back_list' }]
          ];
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Quay lại danh sách
        if (data === 'adm_back_list') {
          const products = db.getAllProducts();
          const keyboard = products.map(p => [{ text: '#' + p.id + ' ' + p.name + ' | 📦 ' + p.stock_count, callback_data: 'adm_product_' + p.id }]);
          keyboard.push([{ text: '➕ Thêm sản phẩm mới', callback_data: 'adm_add_product' }]);
          bot.editMessageText('⚙️ Quản lý sản phẩm:\n\nChọn sản phẩm để sửa/xóa:', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Thêm sản phẩm mới
        if (data === 'adm_add_product') {
          bot.editMessageText('📖 Thêm sản phẩm mới:\n\nGõ lệnh theo cú pháp:\n/addproduct Tên|Giá|Mô tả\n\n▸ Ví dụ:\n/addproduct Netflix 1 tháng|50000|Tài khoản Premium', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '← Quay lại', callback_data: 'adm_back_list' }]] } });
        }

        // Sửa tên
        if (data.startsWith('adm_edit_name_')) {
          const productId = parseInt(data.split('_')[3]);
          waitingEdit.set(userId, { productId, field: 'name', messageId: query.message.message_id });
          bot.editMessageText('✏️ Nhập tên mới cho sản phẩm #' + productId + ':', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✖️ Hủy', callback_data: 'adm_product_' + productId }]] } });
        }

        // Sửa giá
        if (data.startsWith('adm_edit_price_')) {
          const productId = parseInt(data.split('_')[3]);
          waitingEdit.set(userId, { productId, field: 'price', messageId: query.message.message_id });
          bot.editMessageText('💵 Nhập giá mới (số) cho sản phẩm #' + productId + ':', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✖️ Hủy', callback_data: 'adm_product_' + productId }]] } });
        }

        // Sửa mô tả
        if (data.startsWith('adm_edit_desc_')) {
          const productId = parseInt(data.split('_')[3]);
          waitingEdit.set(userId, { productId, field: 'desc', messageId: query.message.message_id });
          bot.editMessageText('📝 Nhập mô tả mới cho sản phẩm #' + productId + ':', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✖️ Hủy', callback_data: 'adm_product_' + productId }]] } });
        }

        // Thêm stock
        if (data.startsWith('adm_addstock_')) {
          const productId = parseInt(data.split('_')[2]);
          const product = db.getProduct(productId);
          waitingStock.set(userId, productId);
          bot.editMessageText('➕ Thêm stock cho: ' + product.name + '\n\nGửi danh sách tài khoản (mỗi dòng 1 tk):', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✖️ Hủy', callback_data: 'adm_product_' + productId }]] } });
        }

        // Xem stock
        if (data.startsWith('adm_viewstock_')) {
          const productId = parseInt(data.split('_')[2]);
          const product = db.getProduct(productId);
          const stocks = db.getStockByProduct(productId);
          const available = stocks.filter(s => !s.is_sold);
          let text = '📦 ' + product.name + '\n\n🎯 Còn: ' + available.length + ' | ✖️ Đã bán: ' + (stocks.length - available.length) + '\n\n';
          const keyboard = [];
          if (available.length > 0) {
            text += 'Tài khoản còn (bấm để xóa):\n';
            available.slice(0, 10).forEach((s, i) => {
              text += (i + 1) + '. ' + s.account_data + '\n';
              keyboard.push([{ text: '🗑️ Xóa: ' + s.account_data.substring(0, 25) + '...', callback_data: 'adm_delstock_' + productId + '_' + s.id }]);
            });
            if (available.length > 10) text += '... và ' + (available.length - 10) + ' tài khoản khác\n';
            keyboard.push([{ text: '🗑️ Xóa TẤT CẢ stock', callback_data: 'adm_clearstock_' + productId }]);
          } else {
            text += '✖️ Chưa có tài khoản trong kho!';
          }
          keyboard.push([{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + productId }]);
          keyboard.push([{ text: '← Quay lại', callback_data: 'adm_product_' + productId }]);
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Xóa 1 stock
        if (data.startsWith('adm_delstock_')) {
          const parts = data.split('_');
          const productId = parseInt(parts[2]);
          const stockId = parseInt(parts[3]);
          db.deleteStock(stockId);
          bot.answerCallbackQuery(query.id, { text: '🎯 Đã xóa!' });
          // Refresh lại view
          const product = db.getProduct(productId);
          const stocks = db.getStockByProduct(productId);
          const available = stocks.filter(s => !s.is_sold);
          let text = '📦 ' + product.name + '\n\n🎯 Còn: ' + available.length + ' | ✖️ Đã bán: ' + (stocks.length - available.length) + '\n\n';
          const keyboard = [];
          if (available.length > 0) {
            text += 'Tài khoản còn (bấm để xóa):\n';
            available.slice(0, 10).forEach((s, i) => {
              text += (i + 1) + '. ' + s.account_data + '\n';
              keyboard.push([{ text: '🗑️ Xóa: ' + s.account_data.substring(0, 25) + '...', callback_data: 'adm_delstock_' + productId + '_' + s.id }]);
            });
            if (available.length > 10) text += '... và ' + (available.length - 10) + ' tài khoản khác\n';
            keyboard.push([{ text: '🗑️ Xóa TẤT CẢ stock', callback_data: 'adm_clearstock_' + productId }]);
          } else {
            text += '✖️ Chưa có tài khoản trong kho!';
          }
          keyboard.push([{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + productId }]);
          keyboard.push([{ text: '← Quay lại', callback_data: 'adm_product_' + productId }]);
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Xóa tất cả stock - xác nhận
        if (data.startsWith('adm_clearstock_')) {
          const productId = parseInt(data.split('_')[2]);
          const product = db.getProduct(productId);
          const stocks = db.getStockByProduct(productId);
          const available = stocks.filter(s => !s.is_sold).length;
          bot.editMessageText('⚠️ Xác nhận xóa TẤT CẢ stock?\n\n📦 ' + product.name + '\n🗑️ Sẽ xóa: ' + available + ' tài khoản\n\nHành động này không thể hoàn tác!',
            { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '🗑️ Xóa hết', callback_data: 'adm_confirmclear_' + productId }, { text: '✖️ Hủy', callback_data: 'adm_viewstock_' + productId }]] } });
        }

        // Xác nhận xóa tất cả stock
        if (data.startsWith('adm_confirmclear_')) {
          const productId = parseInt(data.split('_')[2]);
          db.clearStock(productId);
          bot.answerCallbackQuery(query.id, { text: '🎯 Đã xóa tất cả stock!' });
          // Quay lại product detail
          const product = db.getProduct(productId);
          const stocks = db.getStockByProduct(productId);
          const available = stocks.filter(s => !s.is_sold).length;
          const sold = stocks.length - available;
          const text = '📦 ' + product.name + '\n\n◉ ID: #' + product.id + '\n◉ Giá: ' + formatPrice(product.price) + '\n◉ Mô tả: ' + (product.description || 'Chưa có') + '\n\n📊 Kho hàng:\n◉ Còn: ' + available + '\n◉ Đã bán: ' + sold;
          const keyboard = [
            [{ text: '✏️ Sửa tên', callback_data: 'adm_edit_name_' + productId }, { text: '💵 Sửa giá', callback_data: 'adm_edit_price_' + productId }],
            [{ text: '📝 Sửa mô tả', callback_data: 'adm_edit_desc_' + productId }],
            [{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + productId }, { text: '👁️ Xem stock', callback_data: 'adm_viewstock_' + productId }],
            [{ text: '🗑️ Xóa sản phẩm', callback_data: 'adm_delete_' + productId }],
            [{ text: '← Quay lại', callback_data: 'adm_back_list' }]
          ];
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Xóa sản phẩm - xác nhận
        if (data.startsWith('adm_delete_')) {
          const productId = parseInt(data.split('_')[2]);
          const product = db.getProduct(productId);
          bot.editMessageText('⚠️ Xác nhận xóa sản phẩm:\n\n📦 ' + product.name + '\n\nHành động này không thể hoàn tác!', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '🗑️ Xóa luôn', callback_data: 'adm_confirm_delete_' + productId }, { text: '✖️ Hủy', callback_data: 'adm_product_' + productId }]] } });
        }

        // Xác nhận xóa
        if (data.startsWith('adm_confirm_delete_')) {
          const productId = parseInt(data.split('_')[3]);
          db.deleteProduct(productId);
          const products = db.getAllProducts();
          const keyboard = products.map(p => [{ text: '#' + p.id + ' ' + p.name + ' | 📦 ' + p.stock_count, callback_data: 'adm_product_' + p.id }]);
          keyboard.push([{ text: '➕ Thêm sản phẩm mới', callback_data: 'adm_add_product' }]);
          bot.editMessageText('🎯 Đã xóa sản phẩm #' + productId + '!\n\n⚙️ Quản lý sản phẩm:', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }
      }

    } catch (e) { console.log('Callback error:', e.message); }
    bot.answerCallbackQuery(query.id);
  });


  const waitingStock = new Map();
  const waitingEdit = new Map(); // {userId: {productId, field}}

  // ===== ADMIN: Quản lý sản phẩm bằng menu =====
  bot.onText(/\/products/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const products = db.getAllProducts();
    if (products.length === 0) return bot.sendMessage(msg.chat.id, '📦 Chưa có sản phẩm nào!\n\nDùng /addproduct để thêm.');
    const keyboard = products.map(p => [{ text: '#' + p.id + ' ' + p.name + ' | 📦 ' + p.stock_count, callback_data: 'adm_product_' + p.id }]);
    keyboard.push([{ text: '➕ Thêm sản phẩm mới', callback_data: 'adm_add_product' }]);
    bot.sendMessage(msg.chat.id, '⚙️ Quản lý sản phẩm:\n\nChọn sản phẩm để sửa/xóa:', { reply_markup: { inline_keyboard: keyboard } });
  });

  bot.onText(/^\/addproduct$/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '📖 Hướng dẫn thêm sản phẩm:\n\n/addproduct Tên|Giá|Mô tả\n\n▸ Ví dụ:\n/addproduct Netflix 1 tháng|50000|Tài khoản Premium');
  });

  bot.onText(/^\/addstock$/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '📖 Hướng dẫn thêm stock:\n\n/addstock [ID sản phẩm]\n\n▸ Ví dụ:\n/addstock 1\n\nSau đó gửi danh sách tài khoản (mỗi dòng 1 tk)');
  });

  bot.onText(/^\/deleteproduct$/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '📖 Hướng dẫn xóa sản phẩm:\n\n/deleteproduct [ID]\n\n▸ Ví dụ:\n/deleteproduct 1');
  });

  bot.onText(/^\/editproduct$/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '📖 Hướng dẫn sửa sản phẩm:\n\n/editproduct ID|Tên|Giá|Mô tả\n\n▸ Ví dụ:\n/editproduct 1|Netflix 2 tháng|90000|Tài khoản Premium');
  });

  bot.onText(/^\/viewstock$/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '📖 Hướng dẫn xem kho:\n\n/viewstock [ID sản phẩm]\n\n▸ Ví dụ:\n/viewstock 1');
  });

  bot.onText(/\/addproduct (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const parts = match[1].split('|').map(s => s.trim());
    const name = parts[0];
    const price = parts[1];
    const desc = parts.slice(2).join('|');
    if (!name || !price) return bot.sendMessage(msg.chat.id, '✖️ Sai cú pháp! /addproduct Tên|Giá|Mô tả');
    const r = db.addProduct(name, parseInt(price), desc || '');
    bot.sendMessage(msg.chat.id, '🎯 Đã thêm: ' + name + ' (ID: ' + r.lastInsertRowid + ')');
  });

  bot.onText(/\/addstock (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const p = db.getProduct(parseInt(match[1]));
    if (!p) return bot.sendMessage(msg.chat.id, '✖️ Không tìm thấy!');
    waitingStock.set(msg.from.id, parseInt(match[1]));
    bot.sendMessage(msg.chat.id, '📦 Thêm stock cho: ' + p.name + '\n\nGửi danh sách (mỗi dòng 1 tk):');
  });

  bot.onText(/\/deleteproduct (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    db.deleteProduct(parseInt(match[1]));
    bot.sendMessage(msg.chat.id, '🎯 Đã xóa ID: ' + match[1]);
  });

  bot.onText(/\/editproduct (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const parts = match[1].split('|').map(s => s.trim());
    if (parts.length < 2) return bot.sendMessage(msg.chat.id, '✖️ Sai cú pháp! /editproduct ID|Tên|Giá|Mô tả');
    const id = parseInt(parts[0]);
    const product = db.getProduct(id);
    if (!product) return bot.sendMessage(msg.chat.id, '✖️ Không tồn tại!');
    const name = parts[1] || product.name;
    const price = parts[2] ? parseInt(parts[2]) : product.price;
    const desc = parts[3] !== undefined ? parts[3] : product.description;
    db.updateProduct(id, name, price, desc);
    bot.sendMessage(msg.chat.id, '🎯 Đã cập nhật #' + id + '\n📦 ' + name + '\n💵 ' + formatPrice(price));
  });

  bot.onText(/\/viewstock (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const productId = parseInt(match[1]);
    const product = db.getProduct(productId);
    if (!product) return bot.sendMessage(msg.chat.id, '✖️ Không tồn tại!');
    const stocks = db.getStockByProduct(productId);
    if (stocks.length === 0) return bot.sendMessage(msg.chat.id, '📦 ' + product.name + '\n\n✖️ Chưa có tài khoản.');
    const available = stocks.filter(s => !s.is_sold);
    let text = '📦 ' + product.name + '\n\n🎯 Còn: ' + available.length + '\n✖️ Đã bán: ' + (stocks.length - available.length) + '\n\nTài khoản còn:\n';
    available.slice(0, 20).forEach((s, i) => { text += (i + 1) + '. ' + s.account_data + '\n'; });
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/revenue/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const stats = db.getRevenue();
    const products = db.getAllProducts();
    let totalStock = 0;
    products.forEach(p => totalStock += p.stock_count);
    bot.sendMessage(msg.chat.id, '📈 Thống kê:\n\n◉ Doanh thu: ' + formatPrice(stats.total_revenue) + '\n◉ Đơn hoàn thành: ' + stats.total_orders + '\n◉ Sản phẩm: ' + products.length + '\n◉ Tồn kho: ' + totalStock);
  });

  bot.onText(/\/orders/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const orders = db.getRecentOrders(20);
    if (orders.length === 0) return bot.sendMessage(msg.chat.id, '📦 Chưa có đơn hàng.');
    let text = '📦 Đơn hàng gần đây:\n\n';
    orders.forEach(o => { text += (o.status === 'completed' ? '🎯' : '⏳') + ' #' + o.id + ' | ' + o.user_name + ' | ' + o.product_name + ' | ' + formatPrice(o.price) + '\n'; });
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/stats/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const products = db.getAllProducts();
    let text = '📈 Tồn kho:\n\n';
    products.forEach(p => text += '◉ ' + p.name + ': ' + p.stock_count + '\n');
    bot.sendMessage(msg.chat.id, text || '📈 Chưa có sản phẩm');
  });

  bot.onText(/\/admin/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '⚙️ Lệnh Admin:\n\n/products - 📦 Quản lý sản phẩm (có giao diện)\n/stats - Tồn kho\n/revenue - Doanh thu\n/orders - Đơn hàng\n/users - Danh sách user\n/broadcast - Gửi thông báo\n/help - Xem chi tiết');
  });

  bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const users = db.getAllUsers();
    let sent = 0, failed = 0;
    for (const user of users) {
      try { await bot.sendMessage(user.id, '📣 Thông báo:\n\n' + match[1]); sent++; }
      catch (e) { failed++; }
    }
    bot.sendMessage(msg.chat.id, '🎯 Gửi: ' + sent + '\n✖️ Lỗi: ' + failed);
  });

  bot.onText(/\/users/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const users = db.getAllUsers();
    if (users.length === 0) return bot.sendMessage(msg.chat.id, '◉ Chưa có user.');
    let text = '◉ Users (' + users.length + '):\n\n';
    users.slice(0, 50).forEach((u, i) => { text += (i + 1) + '. ' + u.first_name + ' - ' + u.id + '\n'; });
    bot.sendMessage(msg.chat.id, text);
  });

  bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/') || !isAdmin(msg.from.id)) return;

    // Xử lý thêm stock
    const pid = waitingStock.get(msg.from.id);
    if (pid) {
      const accs = msg.text.split('\n').filter(a => a.trim());
      accs.forEach(a => db.addStock(pid, a.trim()));
      waitingStock.delete(msg.from.id);
      bot.sendMessage(msg.chat.id, '🎯 Đã thêm ' + accs.length + ' tài khoản!\n\nGõ /products để quản lý.');
      return;
    }

    // Xử lý sửa sản phẩm
    const editInfo = waitingEdit.get(msg.from.id);
    if (editInfo) {
      const product = db.getProduct(editInfo.productId);
      if (!product) {
        waitingEdit.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, '✖️ Sản phẩm không tồn tại!');
      }

      let newName = product.name;
      let newPrice = product.price;
      let newDesc = product.description;

      if (editInfo.field === 'name') {
        newName = msg.text.trim();
      } else if (editInfo.field === 'price') {
        const priceNum = parseInt(msg.text.trim());
        if (isNaN(priceNum) || priceNum < 0) {
          return bot.sendMessage(msg.chat.id, '✖️ Giá không hợp lệ! Nhập số nguyên.');
        }
        newPrice = priceNum;
      } else if (editInfo.field === 'desc') {
        newDesc = msg.text.trim();
      }

      db.updateProduct(editInfo.productId, newName, newPrice, newDesc);
      waitingEdit.delete(msg.from.id);

      // Hiển thị lại chi tiết sản phẩm
      const updatedProduct = db.getProduct(editInfo.productId);
      const stocks = db.getStockByProduct(editInfo.productId);
      const available = stocks.filter(s => !s.is_sold).length;
      const sold = stocks.length - available;

      const text = '🎯 Đã cập nhật!\n\n📦 ' + updatedProduct.name + '\n\n◉ ID: #' + updatedProduct.id + '\n◉ Giá: ' + formatPrice(updatedProduct.price) + '\n◉ Mô tả: ' + (updatedProduct.description || 'Chưa có') + '\n\n📊 Kho hàng:\n◉ Còn: ' + available + '\n◉ Đã bán: ' + sold;
      const keyboard = [
        [{ text: '✏️ Sửa tên', callback_data: 'adm_edit_name_' + editInfo.productId }, { text: '💵 Sửa giá', callback_data: 'adm_edit_price_' + editInfo.productId }],
        [{ text: '📝 Sửa mô tả', callback_data: 'adm_edit_desc_' + editInfo.productId }],
        [{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + editInfo.productId }, { text: '👁️ Xem stock', callback_data: 'adm_viewstock_' + editInfo.productId }],
        [{ text: '🗑️ Xóa sản phẩm', callback_data: 'adm_delete_' + editInfo.productId }],
        [{ text: '← Quay lại', callback_data: 'adm_back_list' }]
      ];
      bot.sendMessage(msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard } });
      return;
    }
  });

  console.log('🤖 ' + config.SHOP_NAME + ' đang chạy...');
  console.log('💳 Tự động kiểm tra thanh toán SePay mỗi 30 giây');
}

startBot().catch(console.error);
