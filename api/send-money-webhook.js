export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    console.log('Send-money webhook:', JSON.stringify(payload));

    const event = payload.event_type || payload.event || payload.type || '';
    const data = payload.transaction || payload.data || payload;

    const reference = data.reference || '';
    const status = (data.status || '').toLowerCase();

    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const isSuccess = event === 'disbursement.completed' || event === 'send_money.completed' || status === 'completed' || status === 'successful';
    const isFailed = event === 'disbursement.failed' || event === 'send_money.failed' || status === 'failed' || status === 'cancelled';

    if (!isSuccess && !isFailed) return res.status(200).json({ received: true, ignored: true });

    // Find the withdrawal row
    const findRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/withdrawals?marzpay_reference=eq.${reference}&select=*`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        }
      }
    );
    const rows = await findRes.json();

    if (!rows || rows.length === 0) {
      console.error('No withdrawal for reference', reference);
      return res.status(404).json({ error: 'Not found' });
    }

    const w = rows[0];

    if (w.status === 'completed' || w.status === 'failed') {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    const newStatus = isSuccess ? 'completed' : 'failed';

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/withdrawals?id=eq.${w.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        status: newStatus,
        completed_at: new Date().toISOString(),
        raw_response: payload
      })
    });

    // If failed, refund the user
    if (isFailed) {
      const userRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${w.user_id}&select=balance,total_withdrawn`,
        {
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
          }
        }
      );
      const users = await userRes.json();
      if (users && users.length > 0) {
        const u = users[0];
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${w.user_id}`, {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            balance: Number(u.balance) + Number(w.amount),
            total_withdrawn: Math.max(Number(u.total_withdrawn || 0) - Number(w.amount), 0)
          })
        });
        console.log(`Refunded ${w.amount} to user ${w.user_id}`);
      }
    }

    return res.status(200).json({ received: true, status: newStatus });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
