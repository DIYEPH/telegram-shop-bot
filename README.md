# Telegram Shop Bot

Bot Telegram bán tài khoản tự động.

## Cài đặt

```bash
cd telegram-shop-bot
npm install
```

## Cấu hình

1. Copy `.env.example` thành `.env`
2. Lấy Bot Token từ [@BotFather](https://t.me/BotFather)
3. Lấy User ID của bạn từ [@userinfobot](https://t.me/userinfobot)
4. Điền vào file `.env`

```env
BOT_TOKEN=your_bot_token
ADMIN_IDS=your_user_id
SHOP_NAME=Shop Của Bạn
```

## Chạy bot

```bash
npm start
```

## Lệnh User

- `/start` - Bắt đầu
- `/menu` - Xem danh sách sản phẩm
- `/myorders` - Xem đơn hàng

## Lệnh Admin

- `/admin` - Xem tất cả lệnh admin
- `/addproduct <tên>|<giá>|<mô tả>` - Thêm sản phẩm
- `/addstock <product_id>` - Thêm tài khoản vào kho
- `/deleteproduct <id>` - Xóa sản phẩm
- `/broadcast <tin nhắn>` - Gửi thông báo
- `/stats` - Xem thống kê

## Ví dụ thêm sản phẩm

```
/addproduct ChatGPT Plus 1 Tháng|30000|Tài khoản premium 1 tháng
/addstock 1
email1@gmail.com|password1
email2@gmail.com|password2
```
