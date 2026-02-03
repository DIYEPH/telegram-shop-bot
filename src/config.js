require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())),
  SHOP_NAME: process.env.SHOP_NAME || 'Shop Bot',
  SEPAY_API_KEY: process.env.SEPAY_API_KEY,
  BANK_ACCOUNT: process.env.BANK_ACCOUNT,
  BANK_NAME: process.env.BANK_NAME,
  BANK_OWNER: process.env.BANK_OWNER,
  BANK_BIN: process.env.BANK_BIN
};
