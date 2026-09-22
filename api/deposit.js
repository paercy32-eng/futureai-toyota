export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, amount, phone, accessToken } = req.body;

    if (!userId || !amount || !phone || !accessToken) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const amt = Number(amount);
    if (isNaN(amt) || amt < 1000) {
      return res.status(400).json({ error: 'Minimum deposit is 1,000 UGX' });
    }

    // Normalize phone to +256XXXXXXXXX format
    let normalizedPhone = phone.replace(/\s+/g, '');
    if (normalizedPhone.startsWith('0')) normalizedPhone = '+256' + normalizedPhone.slice(1);
    if (normalizedPhone.startsWith('256')) normalizedPhone = '+' + normalizedPhone;
    if (!normalizedPhone.startsWith('+')) normalizedPhone = '+256' + normalizedPhone;

    // Generate UUID v4 reference
    const reference = crypto.randomUUID();

    // Build the callback URL — points back to our webhook
    const host = req.headers.host;
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const callbackUrl = `${protocol}://${host}/api/marzpay-webhook`;

    // Call MarzPay
    const marzResponse = await fetch('https://wallet.wearemarz.com/api/v1/collect-money', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${process.env.MARZPAY_AUTH}`
      },
      body: (() => {
        const fd = new FormData();
        fd.append('phone_number', normalizedPhone);
        fd.append('amount', String(amt));
        fd.append('country', 'UG');
        fd.append('reference', reference);
        fd.append('description', `Deposit for Toyota Uganda - User ${userId.slice(0, 8)}`);
        fd.append('callback_url', callbackUrl);
        return fd;
      })()
    });

    const marzData = await marzResponse.json();

    if (!marzResponse.ok) {
      console.error('MarzPay error:', marzData);
      return res.status(marzResponse.status).json({
        error: marzData.message || marzData.error || 'MarzPay request failed',
        details: marzData
      });
    }

    // Save pending deposit in Supabase
    const depositRow = {
      user_id: userId,
      amount: amt,
      phone_number: normalizedPhone,
      network: normalizedPhone.match(/^\+256(77|78|76|39)/) ? 'MTN' : 'AIRTEL',
      marzpay_reference: reference,
      marzpay_uuid: marzData.uuid || marzData.data?.uuid || null,
      status: 'pending',
      raw_response: marzData
    };

    const saveRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/deposits`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(depositRow)
    });

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      console.error('Supabase save failed:', errText);
      // We still return success from MarzPay's side, but flag the DB issue
    }

    return res.status(200).json({
      success: true,
      reference,
      message: 'Deposit initiated. Approve the USSD prompt on your phone.',
      marzpay: marzData
    });

  } catch (err) {
    console.error('Deposit handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
