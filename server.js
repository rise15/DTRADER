const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json());

// Handle WebSocket upgrade manually to support cloud hosting proxies (like Render)
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// -------------------------------------------------------------
// SAFARICOM DARAJA M-PESA CONFIGURATION
// -------------------------------------------------------------
const MPESA_CONFIG = {
  consumerKey: process.env.CONSUMER_KEY || "YOUR_CONSUMER_KEY",
  consumerSecret: process.env.CONSUMER_SECRET || "YOUR_CONSUMER_SECRET",
  passkey: process.env.PASSKEY || "YOUR_LIPA_NA_MPESA_PASSKEY",
  shortCode: "174379",
  recipientPhone: "254703606219", // Raphael Mugambi (0703606219)
  callbackUrl: "https://your-render-app-url.onrender.com/api/wallet/mpesa-callback",
  env: "sandbox"
};

async function getMpesaToken() {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    const url = MPESA_CONFIG.env === 'sandbox' 
      ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

    const response = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` }
    });
    return response.data.access_token;
  } catch (err) {
    console.error('M-Pesa Token Error:', err.message);
    throw err;
  }
}

// -------------------------------------------------------------
// In-Memory Database & Markets
// -------------------------------------------------------------
const users = [];
const trades = [];

const markets = {
  'R_10':   { name: 'Volatility 10 Index',       price: 1204.32, vol: 0.10, history: [] },
  'R_25':   { name: 'Volatility 25 Index',       price: 2541.87, vol: 0.25, history: [] },
  'R_50':   { name: 'Volatility 50 Index',       price: 4890.15, vol: 0.50, history: [] },
  'R_75':   { name: 'Volatility 75 Index',       price: 6512.64, vol: 0.75, history: [] },
  'R_100':  { name: 'Volatility 100 Index',      price: 9821.43, vol: 1.00, history: [] },
  '1HZ10V': { name: 'Volatility 10 (1s) Index',  price: 798.69,  vol: 0.15, history: [] }
};

Object.keys(markets).forEach(symbol => {
  let basePrice = markets[symbol].price;
  for (let i = 0; i < 20; i++) {
    basePrice += (Math.random() - 0.49) * markets[symbol].vol * 2;
    const price = parseFloat(basePrice.toFixed(2));
    const digit = parseInt(price.toFixed(2).slice(-1), 10);
    markets[symbol].history.push({ price, digit, timestamp: Date.now() - (20 - i) * 1000 });
  }
});

setInterval(() => {
  Object.keys(markets).forEach(symbol => {
    const m = markets[symbol];
    const delta = (Math.random() - 0.495) * m.vol * 4;
    m.price = parseFloat((m.price + delta).toFixed(2));
    const lastDigit = parseInt(m.price.toFixed(2).slice(-1), 10);

    m.history.push({ price: m.price, digit: lastDigit, timestamp: Date.now() });
    if (m.history.length > 50) m.history.shift();
  });

  const payload = JSON.stringify({ type: 'TICK_UPDATE', markets });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}, 1000);

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, mobile, password } = req.body;
  if (!email || !mobile || !password) return res.status(400).json({ error: "All fields required." });

  let formattedMobile = mobile.replace(/[^0-9]/g, '');
  if (formattedMobile.startsWith('0')) formattedMobile = '254' + formattedMobile.slice(1);

  const newUser = {
    id: 'USR-' + Date.now(),
    email,
    mobile: formattedMobile,
    password,
    demoBalance: 10000.00,
    realBalance: 0.00,
    totalPL: 0.00,
    tradeCount: 0
  };

  users.push(newUser);
  res.json({ success: true, user: newUser });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid login credentials." });
  res.json({ success: true, user });
});

app.post('/api/auth/reset-demo', (req, res) => {
  const { userId } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  user.demoBalance = 10000.00;
  res.json({ success: true, demoBalance: user.demoBalance });
});

app.post('/api/trade/execute', (req, res) => {
  const { userId, accountType, symbol, tradeType, stake, durationSeconds, targetDigit } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  const numStake = parseFloat(stake);
  const isDemo = accountType === 'DEMO';
  const currentBal = isDemo ? user.demoBalance : user.realBalance;

  if (currentBal < numStake) return res.status(400).json({ error: "Insufficient balance." });
  const market = markets[symbol];

  if (isDemo) user.demoBalance -= numStake;
  else user.realBalance -= numStake;

  const trade = {
    id: 'TRD-' + Math.floor(Math.random() * 1000000),
    userId,
    accountType,
    symbol,
    symbolName: market.name,
    tradeType,
    stake: numStake,
    entryPrice: market.price,
    status: 'OPEN'
  };

  setTimeout(() => {
    const win = Math.random() < 0.5;
    trade.exitPrice = markets[symbol].price;
    const profit = win ? numStake * 0.80 : -numStake;

    if (win) {
      if (isDemo) user.demoBalance += (numStake + profit);
      else user.realBalance += (numStake + profit);
      trade.status = 'WIN';
      trade.netResult = profit;
    } else {
      trade.status = 'LOSS';
      trade.netResult = -numStake;
    }

    user.totalPL = (user.totalPL || 0) + trade.netResult;

    const updatePayload = JSON.stringify({
      type: 'TRADE_SETTLED',
      trade,
      demoBalance: user.demoBalance,
      realBalance: user.realBalance,
      totalPL: user.totalPL
    });

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(updatePayload);
    });
  }, (durationSeconds || 1) * 1000);

  res.json({ success: true, trade, demoBalance: user.demoBalance, realBalance: user.realBalance });
});

app.post('/api/wallet/stk-push', async (req, res) => {
  const { userId, amount } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  try {
    const accessToken = await getMpesaToken();
    const date = new Date();
    const timestamp = date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');

    const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
    const stkUrl = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const stkPayload = {
      BusinessShortCode: MPESA_CONFIG.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: user.mobile,
      PartyB: MPESA_CONFIG.recipientPhone, // 254703606219 - Raphael Mugambi
      PhoneNumber: user.mobile,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: user.id,
      TransactionDesc: 'Deposit'
    };

    await axios.post(stkUrl, stkPayload, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    res.json({ success: true, message: `STK push prompt sent to ${user.mobile} for Raphael Mugambi.` });
  } catch (err) {
    res.status(500).json({ error: "STK Push failed." });
  }
});

app.post('/api/wallet/withdraw', (req, res) => {
  const { userId, amount } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user || amount > user.realBalance) return res.status(400).json({ error: "Invalid withdrawal." });
  user.realBalance -= parseFloat(amount);
  res.json({ success: true, realBalance: user.realBalance, message: "Withdrawal processed." });
});

// Front-end UI Route
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>TraderScheme Workstation</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-slate-950 text-gray-100 h-screen flex flex-col items-center justify-center">
  <div class="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center max-w-md w-full shadow-2xl">
    <h1 class="text-2xl font-black text-blue-500 mb-2">TraderScheme Online</h1>
    <p class="text-xs text-gray-400 mb-6">Connected to server successfully. Open your app dashboard.</p>
    <div class="text-green-400 font-bold text-sm">Target Recipient: 254703606219 (Raphael Mugambi)</div>
  </div>
</body>
</html>`);
});

// CRITICAL FIX: Use Render's dynamically allocated environment port
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server successfully started and listening on port ${PORT}`);
});
