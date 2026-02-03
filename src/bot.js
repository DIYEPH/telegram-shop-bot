const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./database');
const sepay = require('./sepay');

const formatPrice = (price) => price.toLocaleString('vi-VN') + ' VND';
const isAdmin = (userId) => config.ADMIN_IDS.includes(userId);
const ORDER_TIMEOUT_MS = 20 * 60 * 1000;

const pendingOrders = new Map();
const processingOrders = new Set(); 

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
      { command: 'orders', description: '📦 Đơn hàng' },
      { command: 'revenue', description: '📈 Doanh thu' },
      { command: 'stats', description: '📊 Tồn kho' },
      { command: 'users', description: '👥 Users' },
      { command: 'broadcast', description: '📣 Thông báo' }
    ], { scope: { type: 'chat', chat_id: adminId } });
  });

  bot.on('polling_error', (err) => console.log('Polling error:', err.message));

  setInterval(async () => {
    const now = Date.now();
    for (const [orderId, order] of pendingOrders) {
      if (processingOrders.has(orderId)) continue;
      
      if (now - order.createdAt > ORDER_TIMEOUT_MS) {
        pendingOrders.delete(orderId);
        db.updateOrder(orderId, null, 'expired');
        bot.sendMessage(order.chatId, '✖️ Đơn #' + orderId + ' đã hết hạn do không thanh toán trong 20 phút.\n\n⚡ Mua lại? Gõ /menu');
        continue;
      }
      processingOrders.add(orderId);
      
      const paid = await sepay.checkPayment(order.content, order.totalPrice);
      if (paid) {
        pendingOrders.delete(orderId);
        const product = db.getProduct(order.productId);
        let accounts = [];
        for (let i = 0; i < order.quantity; i++) {
          const stock = db.getAvailableStock(order.productId);
          if (stock) { db.markStockSold(stock.id, order.userId); accounts.push(stock.account_data); }
        }
        if (accounts.length > 0) {
          db.updateOrder(orderId, null, 'completed');
          let accText = accounts.map((a, idx) => '  ' + (idx + 1) + '. ' + a).join('\n');
          const successMsg = '✅ THANH TOÁN THÀNH CÔNG!\n' +
                             '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                             '🎁 ' + product.name + ' x' + order.quantity + '\n\n' +
                             '🔑 TÀI KHOẢN:\n' +
                             accText + '\n\n' +
                             '⚠️ Đổi mật khẩu ngay!\n' +
                             '⛄ Cảm ơn bạn đã mua hàng!\n' +
                             '🛒 Mua thêm? Gõ /menu';
          bot.sendMessage(order.chatId, successMsg);
          config.ADMIN_IDS.forEach(id => bot.sendMessage(id, '🔔 Đơn #' + orderId + ' ĐÃ THANH TOÁN\n👤 User: ' + order.userId + '\n🎁 ' + product.name + ' x' + order.quantity + '\n💵 ' + formatPrice(order.totalPrice)));
        }
      }
      
      // Unlock sau khi xong
      processingOrders.delete(orderId);
    }
  }, 30000);

  bot.onText(/\/start/, (msg) => {
    db.saveUser(msg.from.id, msg.from.first_name, msg.from.username || '');
    const products = db.getAllProducts();
    const keyboard = products.map(p => [{ text: '🎁 ' + p.name + ' ┃ ' + formatPrice(p.price) + ' ┃ 📦' + p.stock_count, callback_data: 'product_' + p.id }]);
    keyboard.push([{ text: '👤 Hồ sơ', callback_data: 'main_profile' }, { text: '📋 Lịch sử', callback_data: 'main_history' }]);
    const text = '⛄ ' + config.SHOP_NAME + '\n' +
                 '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                 '✨ Xin chào, ' + msg.from.first_name + '!\n\n' +
                 (products.length > 0 ? '🛒 Chọn sản phẩm để mua:' : '⛄ Chưa có sản phẩm nào!');
    bot.sendMessage(msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard } });
  });

  bot.onText(/\/menu/, (msg) => {
    db.saveUser(msg.from.id, msg.from.first_name, msg.from.username || '');
    const products = db.getAllProducts();
    const keyboard = products.map(p => [{ text: '🎁 ' + p.name + ' ┃ ' + formatPrice(p.price) + ' ┃ 📦' + p.stock_count, callback_data: 'product_' + p.id }]);
    keyboard.push([{ text: '👤 Hồ sơ', callback_data: 'main_profile' }, { text: '📋 Lịch sử', callback_data: 'main_history' }]);
    const text = '🛒 CỬA HÀNG\n' +
                 '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                 (products.length > 0 ? '⛄ Chọn sản phẩm:' : '⛄ Chưa có sản phẩm nào!');
    bot.sendMessage(msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard } });
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

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    try {
      if (data === 'main_shop') {
        const products = db.getAllProducts();
        if (products.length === 0) return bot.answerCallbackQuery(query.id, { text: '❄️ Chưa có sản phẩm!' });
        const keyboard = products.map(p => [{ text: '🎁 ' + p.name + ' ┃ ' + formatPrice(p.price) + ' ┃ 📦' + p.stock_count, callback_data: 'product_' + p.id }]);
        keyboard.push([{ text: '👤 Hồ sơ', callback_data: 'main_profile' }, { text: '📋 Lịch sử', callback_data: 'main_history' }]);
        const text = '🛒 CỬA HÀNG\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     '⛄ Chọn sản phẩm:';
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
      }

      if (data === 'main_profile') {
        const orders = db.getOrdersByUser(userId);
        const completed = orders.filter(o => o.status === 'completed');
        const totalSpent = completed.reduce((sum, o) => sum + o.price, 0);
        const text = '👤 HỒ SƠ CỦA BẠN\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     '🆔 ID: ' + userId + '\n' +
                     '✨ Tên: ' + query.from.first_name + '\n' +
                     '📧 Username: ' + (query.from.username ? '@' + query.from.username : 'Chưa có') + '\n\n' +
                     '📊 THỐNG KÊ\n' +
                     '🛍️ Đơn hoàn thành: ' + completed.length + '\n' +
                     '💰 Đã chi tiêu: ' + formatPrice(totalSpent);
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '◀️ Quay lại', callback_data: 'back_main' }]] } });
      }

      if (data === 'main_history') {
        const orders = db.getOrderHistory(userId);
        if (orders.length === 0) return bot.answerCallbackQuery(query.id, { text: '❄️ Chưa có lịch sử!' });
        let text = '📋 LỊCH SỬ MUA HÀNG\n' +
                   '━━━━━━━━━━━━━━━━━━━━━\n\n';
        orders.slice(0, 10).forEach((o, idx) => {
          const statusIcon = o.status === 'completed' ? '✅' : o.status === 'pending' ? '⏳' : o.status === 'expired' ? '⌛' : '❌';
          const statusText = o.status === 'completed' ? 'Thành công' : o.status === 'pending' ? 'Chờ TT' : o.status === 'expired' ? 'Hết hạn' : 'Đã hủy';
          text += statusIcon + ' Đơn #' + o.id + ' • ' + statusText + '\n';
          text += '   🎁 ' + o.product_name + ' x' + (o.quantity || 1) + '\n';
          text += '   💵 ' + formatPrice(o.total_price || 0) + '\n';
          if (idx < orders.length - 1) text += '\n';
        });
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '◀️ Quay lại', callback_data: 'back_main' }]] } });
      }

      if (data === 'back_main') {
        const products = db.getAllProducts();
        const keyboard = products.map(p => [{ text: '🎁 ' + p.name + ' ┃ ' + formatPrice(p.price) + ' ┃ 📦' + p.stock_count, callback_data: 'product_' + p.id }]);
        keyboard.push([{ text: '👤 Hồ sơ', callback_data: 'main_profile' }, { text: '📋 Lịch sử', callback_data: 'main_history' }]);
        const text = '🛒 CỬA HÀNG\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     (products.length > 0 ? '⛄ Chọn sản phẩm:' : '⛄ Chưa có sản phẩm nào!');
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
      }

      if (data.startsWith('product_')) {
        const product = db.getProduct(parseInt(data.split('_')[1]));
        if (!product) return bot.answerCallbackQuery(query.id, { text: '❄️ Không tồn tại!' });
        const stock = product.stock_count;
        
        // Tạo nút số lượng thông minh
        const presets = [1, 2, 3, 5, 10];
        const qtyButtons = [];
        presets.forEach(n => {
          if (n <= stock) qtyButtons.push({ text: '『' + n + '』', callback_data: 'qty_' + product.id + '_' + n });
        });
        // Thêm nút MAX nếu stock > 10
        if (stock > 10) {
          qtyButtons.push({ text: '『MAX:' + stock + '』', callback_data: 'qty_' + product.id + '_' + stock });
        }
        
        const keyboard = [];
        // Chia nút thành 2 hàng nếu nhiều
        if (qtyButtons.length <= 3) {
          keyboard.push(qtyButtons);
        } else {
          keyboard.push(qtyButtons.slice(0, 3));
          keyboard.push(qtyButtons.slice(3));
        }
        // Thêm nút nhập SL tùy chỉnh nếu stock > 5
        if (stock > 5) {
          keyboard.push([{ text: '📝 Nhập số lượng khác', callback_data: 'customqty_' + product.id }]);
        }
        keyboard.push([{ text: '◀️ Quay lại', callback_data: 'main_shop' }]);
        
        const text = '🎁 ' + product.name + '\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     '💰 Giá: ' + formatPrice(product.price) + '/sp\n' +
                     '📊 Còn: ' + stock + ' sản phẩm\n' +
                     (product.description ? '📝 ' + product.description + '\n' : '') +
                     '\n⛄ Chọn số lượng:';
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
      }
      
      // Nhập số lượng tùy chỉnh
      if (data.startsWith('customqty_')) {
        const productId = parseInt(data.split('_')[1]);
        const product = db.getProduct(productId);
        if (!product) return bot.answerCallbackQuery(query.id, { text: '❄️ Không tồn tại!' });
        waitingEdit.set(userId, { field: 'custom_qty', productId, messageId: query.message.message_id });
        const text = '📝 NHẬP SỐ LƯỢNG\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     '📦 ' + product.name + '\n' +
                     '💰 Giá: ' + formatPrice(product.price) + '/sp\n' +
                     '📊 Còn: ' + product.stock_count + ' sp\n\n' +
                     '✏️ Nhập số lượng muốn mua:';
        bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'product_' + productId }]] } });
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
        const caption = '💳 THANH TOÁN ĐƠN #' + orderId + '\n' +
                        '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        '🎁 ' + product.name + ' x' + qty + '\n' +
                        '💰 Tổng: ' + formatPrice(totalPrice) + '\n\n' +
                        '🏦 THÔNG TIN CHUYỂN KHOẢN\n' +
                        '• NH: ' + config.BANK_NAME + '\n' +
                        '• STK: ' + config.BANK_ACCOUNT + '\n' +
                        '• Chủ TK: ' + config.BANK_OWNER + '\n' +
                        '• Nội dung: ' + content + '\n\n' +
                        '📲 Quét QR để thanh toán\n' +
                        '⏳ Tự động xác nhận khi nhận tiền\n' +
                        '⚠️ Đơn hết hạn sau 20 phút';
        await bot.sendPhoto(chatId, getQRUrl(totalPrice, content), {
          caption: caption,
          reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra thanh toán', callback_data: 'check_' + orderId + '_' + productId + '_' + qty }], [{ text: '❌ Hủy đơn', callback_data: 'cancel_' + orderId }]] }
        });
        return;
      }

      if (data.startsWith('check_')) {
        const [, orderId, productId, quantity] = data.split('_');
        const orderIdNum = parseInt(orderId);
        const order = pendingOrders.get(orderIdNum);
        if (!order) return bot.answerCallbackQuery(query.id, { text: '✖️ Đơn hàng không tồn tại hoặc đã xử lý!', show_alert: true });
        
        // Kiểm tra lock - nếu đang xử lý thì báo chờ
        if (processingOrders.has(orderIdNum)) {
          return bot.answerCallbackQuery(query.id, { text: '⏳ Đang xử lý, vui lòng chờ...', show_alert: true });
        }
        
        // Lock trước khi check
        processingOrders.add(orderIdNum);

        const product = db.getProduct(parseInt(productId));
        const qty = parseInt(quantity) || 1;

        const paid = await sepay.checkPayment(order.content, order.totalPrice);
        if (paid) {
          pendingOrders.delete(orderIdNum);
          let accounts = [];
          for (let i = 0; i < qty; i++) {
            const stock = db.getAvailableStock(parseInt(productId));
            if (stock) { db.markStockSold(stock.id, userId); accounts.push(stock.account_data); }
          }
          if (accounts.length > 0) {
            db.updateOrder(orderIdNum, null, 'completed');
            let accText = accounts.map((a, idx) => '  ' + (idx + 1) + '. ' + a).join('\n');
            bot.answerCallbackQuery(query.id, { text: '✅ Thanh toán thành công!' });
            const successMsg = '✅ THANH TOÁN THÀNH CÔNG!\n' +
                               '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                               '🎁 ' + product.name + ' x' + qty + '\n\n' +
                               '🔑 TÀI KHOẢN:\n' +
                               accText + '\n\n' +
                               '⚠️ Đổi mật khẩu ngay!\n' +
                               '⛄ Cảm ơn bạn đã mua hàng!\n' +
                               '🛒 Mua thêm? Gõ /menu';
            await bot.sendMessage(chatId, successMsg);
            config.ADMIN_IDS.forEach(id => bot.sendMessage(id, '🔔 Đơn #' + orderId + ' ĐÃ THANH TOÁN\n👤 ' + query.from.first_name + ' (' + userId + ')\n🎁 ' + product.name + ' x' + qty + '\n💵 ' + formatPrice(order.totalPrice)));
          }
        } else {
          bot.answerCallbackQuery(query.id, { text: '❄️ Chưa nhận được thanh toán! Thử lại sau.', show_alert: true });
        }
        
        // Unlock
        processingOrders.delete(orderIdNum);
        return;
      }

      // Hủy broadcast
      if (data === 'cancel_broadcast') {
        waitingEdit.delete(userId);
        bot.editMessageText('❌ Đã hủy gửi thông báo.', { chat_id: chatId, message_id: query.message.message_id });
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
        const keyboard = products.map(p => [{ text: '🎁 ' + p.name + ' ┃ ' + formatPrice(p.price) + ' ┃ 📦' + p.stock_count, callback_data: 'product_' + p.id }]);
        keyboard.push([{ text: '👤 Hồ sơ', callback_data: 'main_profile' }, { text: '📋 Lịch sử', callback_data: 'main_history' }]);
        const text = '🛒 CỬA HÀNG\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     (products.length > 0 ? '⛄ Chọn sản phẩm:' : '⛄ Chưa có sản phẩm nào!');
        if (query.message.photo) {
          await bot.deleteMessage(chatId, query.message.message_id);
          bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
        } else {
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }
      }

      // ===== ADMIN CALLBACKS =====
      if (data.startsWith('adm_') && isAdmin(userId)) {

        // Xem chi tiết sản phẩm
        if (data.startsWith('adm_product_')) {
          const productId = parseInt(data.split('_')[2]);
          const product = db.getProduct(productId);
          if (!product) return bot.answerCallbackQuery(query.id, { text: '❄️ Không tồn tại!' });
          const stocks = db.getStockByProduct(productId);
          const available = stocks.filter(s => !s.is_sold).length;
          const sold = stocks.length - available;

          const text = '📦 ' + product.name + ' (#' + product.id + ')\n' +
                       '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                       '💰 Giá: ' + formatPrice(product.price) + '\n' +
                       '📝 Mô tả: ' + (product.description || 'Chưa có') + '\n\n' +
                       '📊 KHO: ✅' + available + ' còn │ 🔴' + sold + ' đã bán';
          const keyboard = [
            [{ text: '✏️ Sửa tên', callback_data: 'adm_edit_name_' + productId }, { text: '💵 Sửa giá', callback_data: 'adm_edit_price_' + productId }],
            [{ text: '📝 Sửa mô tả', callback_data: 'adm_edit_desc_' + productId }],
            [{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + productId }, { text: '👁️ Xem stock', callback_data: 'adm_viewstock_' + productId }],
            [{ text: '🗑️ Xóa sản phẩm', callback_data: 'adm_delete_' + productId }],
            [{ text: '◀️ Quay lại', callback_data: 'adm_back_list' }]
          ];
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Quay lại danh sách
        if (data === 'adm_back_list') {
          const products = db.getAllProducts();
          const keyboard = products.map(p => [{ text: '📦 #' + p.id + ' ' + p.name + ' ┃ 🎯' + p.stock_count, callback_data: 'adm_product_' + p.id }]);
          keyboard.push([{ text: '➕ Thêm sản phẩm mới', callback_data: 'adm_add_product' }]);
          const text = '⚙️ QUẢN LÝ SẢN PHẨM\n' +
                       '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                       '📊 Tổng: ' + products.length + ' sản phẩm\n' +
                       '⛄ Chọn để sửa/xóa:';
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
        }

        // Thêm sản phẩm mới
        if (data === 'adm_add_product') {
          waitingEdit.set(userId, { field: 'new_product', messageId: query.message.message_id });
          const text = '➕ THÊM SẢN PHẨM MỚI\n' +
                       '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                       '📝 Nhập theo format:\n' +
                       'Tên|Giá|Mô tả\n\n' +
                       '▸ Ví dụ:\n' +
                       'Netflix 1 tháng|50000|Premium';
          bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'adm_back_list' }]] } });
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
    const keyboard = products.map(p => [{ text: '📦 #' + p.id + ' ' + p.name + ' ┃ 🎯' + p.stock_count, callback_data: 'adm_product_' + p.id }]);
    keyboard.push([{ text: '➕ Thêm sản phẩm mới', callback_data: 'adm_add_product' }]);
    const text = '⚙️ QUẢN LÝ SẢN PHẨM\n' +
                 '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                 '📊 Tổng: ' + products.length + ' sản phẩm\n' +
                 '⛄ Chọn để sửa/xóa:';
    bot.sendMessage(msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard } });
  });

  bot.onText(/\/revenue/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const stats = db.getRevenue();
    const products = db.getAllProducts();
    let totalStock = 0;
    products.forEach(p => totalStock += p.stock_count);
    const text = '💰 DOANH THU\n' +
                 '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                 '💵 Tổng thu: ' + formatPrice(stats.total_revenue) + '\n' +
                 '✅ Đơn hoàn thành: ' + stats.total_orders + '\n\n' +
                 '📊 TỔNG QUAN\n' +
                 '📦 Sản phẩm: ' + products.length + '\n' +
                 '🎯 Tồn kho: ' + totalStock;
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/orders/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const orders = db.getRecentOrders(20);
    if (orders.length === 0) {
      return bot.sendMessage(msg.chat.id, '📦 ĐƠN HÀNG\n━━━━━━━━━━━━━━━━━━━━━\n\n⛄ Chưa có đơn hàng nào!');
    }
    let text = '📦 ĐƠN HÀNG GẦN ĐÂY\n' +
               '━━━━━━━━━━━━━━━━━━━━━\n\n';
    orders.forEach((o, idx) => {
      const icon = o.status === 'completed' ? '✅' : o.status === 'pending' ? '⏳' : '❌';
      const time = o.created_at ? new Date(o.created_at).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'N/A';
      text += icon + ' #' + o.id + ' │ ' + o.user_name + '\n';
      text += '   🎁 ' + o.product_name + ' x' + o.quantity + '\n';
      text += '   💵 ' + formatPrice(o.total_price || 0) + ' │ 🕐 ' + time + '\n';
      if (idx < orders.length - 1) text += '\n';
    });
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/stats/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const products = db.getAllProducts();
    let text = '📊 TỒN KHO\n' +
               '━━━━━━━━━━━━━━━━━━━━━\n\n';
    if (products.length === 0) {
      text += '⛄ Chưa có sản phẩm nào!';
    } else {
      let total = 0;
      products.forEach(p => {
        const status = p.stock_count > 0 ? '✅' : '🔴';
        text += status + ' ' + p.name + ': ' + p.stock_count + '\n';
        total += p.stock_count;
      });
      text += '\n📦 Tổng: ' + total;
    }
    bot.sendMessage(msg.chat.id, text);
  });

  // /broadcast - Gửi thông báo
  bot.onText(/^\/broadcast$/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const users = db.getAllUsers();
    waitingEdit.set(msg.from.id, { field: 'broadcast' });
    const text = '📣 GỬI THÔNG BÁO\n' +
                 '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                 '👥 Sẽ gửi đến: ' + users.length + ' users\n\n' +
                 '✏️ Nhập nội dung thông báo:';
    bot.sendMessage(msg.chat.id, text, {
      reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'cancel_broadcast' }]] }
    });
  });

  bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const users = db.getAllUsers();
    let sent = 0, failed = 0;
    for (const user of users) {
      try { await bot.sendMessage(user.id, '📣 Thông báo:\n\n' + match[1]); sent++; }
      catch (e) { failed++; }
    }
    const text = '✅ ĐÃ GỬI THÔNG BÁO\n' +
                 '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                 '✅ Thành công: ' + sent + '\n' +
                 '❌ Thất bại: ' + failed;
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/users/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const users = db.getAllUsers();
    let text = '👥 DANH SÁCH USER\n' +
               '━━━━━━━━━━━━━━━━━━━━━\n\n';
    if (users.length === 0) {
      text += '⛄ Chưa có user nào!';
    } else {
      text += '📊 Tổng: ' + users.length + ' users\n\n';
      users.slice(0, 50).forEach((u, i) => {
        text += (i + 1) + '. ' + u.first_name + ' │ ' + u.id + '\n';
      });
    }
    bot.sendMessage(msg.chat.id, text);
  });

  // Handler cho user nhập số lượng tùy chỉnh
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const editInfo = waitingEdit.get(msg.from.id);
    if (editInfo && editInfo.field === 'custom_qty') {
      const qty = parseInt(msg.text.trim());
      const product = db.getProduct(editInfo.productId);
      
      if (!product) {
        waitingEdit.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, '✖️ Sản phẩm không tồn tại!');
      }
      
      if (isNaN(qty) || qty < 1) {
        return bot.sendMessage(msg.chat.id, '✖️ Số lượng không hợp lệ! Nhập số nguyên > 0', {
          reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'product_' + editInfo.productId }]] }
        });
      }
      
      if (qty > product.stock_count) {
        return bot.sendMessage(msg.chat.id, '✖️ Không đủ hàng! Chỉ còn ' + product.stock_count + ' sản phẩm.', {
          reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'product_' + editInfo.productId }]] }
        });
      }
      
      waitingEdit.delete(msg.from.id);
      
      // Tạo đơn hàng
      const totalPrice = product.price * qty;
      const content = generateCode();
      const order = db.createOrder(msg.from.id, editInfo.productId, msg.chat.id, content, qty, totalPrice);
      const orderId = order.lastInsertRowid;
      pendingOrders.set(orderId, { chatId: msg.chat.id, userId: msg.from.id, productId: editInfo.productId, quantity: qty, totalPrice, content, createdAt: order.createdAt });
      
      const caption = '💳 THANH TOÁN ĐƠN #' + orderId + '\n' +
                      '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                      '🎁 ' + product.name + ' x' + qty + '\n' +
                      '💰 Tổng: ' + formatPrice(totalPrice) + '\n\n' +
                      '🏦 THÔNG TIN CHUYỂN KHOẢN\n' +
                      '• NH: ' + config.BANK_NAME + '\n' +
                      '• STK: ' + config.BANK_ACCOUNT + '\n' +
                      '• Chủ TK: ' + config.BANK_OWNER + '\n' +
                      '• Nội dung: ' + content + '\n\n' +
                      '📲 Quét QR để thanh toán\n' +
                      '⏳ Tự động xác nhận khi nhận tiền\n' +
                      '⚠️ Đơn hết hạn sau 20 phút';
      await bot.sendPhoto(msg.chat.id, getQRUrl(totalPrice, content), {
        caption: caption,
        reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra thanh toán', callback_data: 'check_' + orderId + '_' + editInfo.productId + '_' + qty }], [{ text: '❌ Hủy đơn', callback_data: 'cancel_' + orderId }]] }
      });
      return;
    }
  });

  // Handler cho admin
  bot.on('message', async (msg) => {
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

    // Xử lý sửa/thêm sản phẩm
    const editInfo = waitingEdit.get(msg.from.id);
    if (editInfo) {
      
      // Gửi broadcast
      if (editInfo.field === 'broadcast') {
        waitingEdit.delete(msg.from.id);
        const users = db.getAllUsers();
        let sent = 0, failed = 0;
        
        bot.sendMessage(msg.chat.id, '⏳ Đang gửi thông báo đến ' + users.length + ' users...');
        
        for (const user of users) {
          try { await bot.sendMessage(user.id, '📣 Thông báo:\n\n' + msg.text); sent++; }
          catch (e) { failed++; }
        }
        
        const text = '✅ ĐÃ GỬI THÔNG BÁO\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     '✅ Thành công: ' + sent + '\n' +
                     '❌ Thất bại: ' + failed;
        bot.sendMessage(msg.chat.id, text);
        return;
      }
      
      // Thêm sản phẩm MỚI
      if (editInfo.field === 'new_product') {
        const parts = msg.text.split('|').map(s => s.trim());
        const name = parts[0];
        const price = parseInt(parts[1]);
        const desc = parts.slice(2).join('|') || '';
        
        if (!name || isNaN(price) || price < 0) {
          return bot.sendMessage(msg.chat.id, '✖️ Sai format! Nhập lại:\nTên|Giá|Mô tả\n\nVí dụ: Netflix 1 tháng|50000|Tài khoản Premium', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'adm_back_list' }]] }
          });
        }
        
        const result = db.addProduct(name, price, desc);
        waitingEdit.delete(msg.from.id);
        
        // Hiển thị sản phẩm vừa tạo
        const productId = result.lastInsertRowid;
        const text = '✅ ĐÃ THÊM SẢN PHẨM\n' +
                     '━━━━━━━━━━━━━━━━━━━━━\n\n' +
                     '📦 ' + name + ' (#' + productId + ')\n' +
                     '💰 Giá: ' + formatPrice(price) + '\n' +
                     '📝 Mô tả: ' + (desc || 'Chưa có') + '\n\n' +
                     '📊 KHO: ✅0 còn │ 🔴0 đã bán';
        const keyboard = [
          [{ text: '✏️ Sửa tên', callback_data: 'adm_edit_name_' + productId }, { text: '💵 Sửa giá', callback_data: 'adm_edit_price_' + productId }],
          [{ text: '📝 Sửa mô tả', callback_data: 'adm_edit_desc_' + productId }],
          [{ text: '➕ Thêm stock', callback_data: 'adm_addstock_' + productId }, { text: '👁️ Xem stock', callback_data: 'adm_viewstock_' + productId }],
          [{ text: '🗑️ Xóa sản phẩm', callback_data: 'adm_delete_' + productId }],
          [{ text: '← Quay lại', callback_data: 'adm_back_list' }]
        ];
        bot.sendMessage(msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard } });
        return;
      }
      
      // Sửa sản phẩm hiện có
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
          return bot.sendMessage(msg.chat.id, '✖️ Giá không hợp lệ! Nhập số nguyên.', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'adm_product_' + editInfo.productId }]] }
          });
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
