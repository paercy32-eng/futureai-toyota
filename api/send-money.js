export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { withdrawalId, phone, amount, fullName } = req.body;

    if (!withdrawalId || !phone || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const amt = Number(amount);
    if (isNaN(amt) || amt < 500) {
      return res.status(400).json({ error: 'Minimum send amount is 500 UGX' });
    }

    // Normalize phone
    let normalizedPhone = phone.replace(/\s+/g, '');
    if (normalizedPhone.startsWith('0')) normalizedPhone = '+256' + normalizedPhone.slice(1);
    if (normalizedPhone.startsWith('256')) normalizedPhone = '+' + normalizedPhone;
    if (!normalizedPhone.startsWith('+')) normalizedPhone = '+256' + normalizedPhone;

    const reference = crypto.randomUUID();
    const host = req.headers.host;
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const callbackUrl = `${protocol}://${host}/api/send-money-webhook`;

    // Call MarzPay send-money
    const fd = new FormData();
    fd.append('phone_number', normalizedPhone);
    fd.append('amount', String(amt));
    fd.append('country', 'UG');
    fd.append('reference', reference);
    fd.append('description', `Withdrawal for ${fullName || 'user'} - Toyota Uganda`);
    fd.append('callback_url', callbackUrl);

    const marzResponse = await fetch('https://wallet.wearemarz.com/api/v1/send-money', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${process.env.MARZPAY_AUTH}`
      },
      body: fd
    });

    const marzData = await marzResponse.json();

    if (!marzResponse.ok) {
      console.error('MarzPay send error:', marzData);
      return res.status(marzResponse.status).json({
        error: marzData.message || marzData.error || 'MarzPay send request failed',
        details: marzData
      });
    }

    // Update withdrawal with MarzPay info
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/withdrawals?id=eq.${withdrawalId}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        status: 'processing',
        marzpay_reference: reference,
        marzpay_uuid: marzData.uuid || marzData.data?.uuid || null,
        raw_response: marzData
      })
    });

    return res.status(200).json({
      success: true,
      reference,
      message: 'Send request initiated',
      marzpay: marzData
    });

  } catch (err) {
    console.error('Send money handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
        }
