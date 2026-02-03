const config = require('./config');

async function getTransactions() {
  try {
    const response = await fetch('https://my.sepay.vn/userapi/transactions/list', {
      headers: { 'Authorization': `Bearer ${config.SEPAY_API_KEY}` }
    });
    const data = await response.json();
    console.log('SePay response:', JSON.stringify(data, null, 2));
    return data.transactions || [];
  } catch (e) {
    console.log('SePay error:', e.message);
    return [];
  }
}

async function checkPayment(content, amount) {
  const transactions = await getTransactions();
  
  const found = transactions.find(t => {
    const transContent = t.transaction_content || t.content || t.description || '';
    const transAmount = parseInt(t.amount_in || t.amount || 0);
    return transContent.toUpperCase().includes(content.toUpperCase()) && transAmount >= amount;
  });
  
  return !!found;
}

module.exports = { getTransactions, checkPayment };
