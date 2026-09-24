export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    console.log('=== SEND-MONEY WEBHOOK ===');
    console.log(JSON.stringify(payload));

    const eventType = payload.event_type || payload.event || payload.type || '';
    const tx = payload.transaction || payload.data || payload;
    const reference = tx.reference || payload.reference || '';
    const uuid = tx.uuid || '';
    const amount = Number(tx.amount?.raw || tx.amount || 0);
    const status = String(tx.status || '').toLowerCase();

    console.log('Event:', eventType, '| Ref:', reference, '| UUID:', uuid, '| Amount:', amount, '| Status:', status);

    const isSuccess =
      eventType === 'disbursement.completed' ||
      eventType === 'send_money.completed' ||
      status === 'completed' || status === 'successful' || status === 'success';

    const isFailed =
      eventType === 'disbursement.failed' ||
      eventType === 'send_money.failed' ||
      status === 'failed' || status === 'cancelled' || status === 'rejected';

    if (!isSuccess && !isFailed) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const sbHeaders = {
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
    };

    let w = null;

    // Strategy 1: match by marzpay_reference = reference
    if (reference) {
      const r1 = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/withdrawals?marzpay_reference=eq.${reference}&select=*`,
        { headers: sbHeaders }
      );
      const rows1 = await r1.json();
      if (rows1 && rows1.length > 0) { w = rows1[0]; console.log('Matched by reference'); }
    }

    // Strategy 2: match by marzpay_uuid = uuid
    if (!w && uuid) {
      const r2 = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/withdrawals?marzpay_uuid=eq.${uuid}&select=*`,
        { headers: sbHeaders }
      );
      const rows2 = await r2.json();
      if (rows2 && rows2.length > 0) { w = rows2[0]; console.log('Matched by uuid'); }
    }

    // Strategy 3: match by amount + processing + recent (last 30 min)
    if (!w && amount > 0) {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const r3 = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/withdrawals?status=in.(processing,pending)&amount=eq.${amount}&requested_at=gte.${thirtyMinAgo}&select=*&order=requested_at.desc&limit=1`,
        { headers: sbHeaders }
      );
      const rows3 = await r3.json();
      if (rows3 && rows3.length > 0) { w = rows3[0]; console.log('Matched by amount+recency'); }
    }

    if (!w) {
      console.log('No matching withdrawal found');
      return res.status(200).json({ received: true, warning: 'Withdrawal not found' });
    }

    if (w.status === 'completed' || w.status === 'failed') {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    const newStatus = isSuccess ? 'completed' : 'failed';

    // Update the withdrawal
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/withdrawals?id=eq.${w.id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        status: newStatus,
        completed_at: new Date().toISOString(),
        marzpay_uuid: uuid || w.marzpay_uuid,
        raw_response: payload
      })
    });

    console.log('Withdrawal', w.id, 'marked as', newStatus);

    // If failed, refund
    if (isFailed) {
      const uRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${w.user_id}&select=balance,total_withdrawn`,
        { headers: sbHeaders }
      );
      const users = await uRes.json();
      if (users && users.length > 0) {
        const u = users[0];
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${w.user_id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            balance: Number(u.balance || 0) + Number(w.amount || 0),
            total_withdrawn: Math.max(Number(u.total_withdrawn || 0) - Number(w.amount || 0), 0)
          })
        });
        console.log('Refunded', w.amount, 'to', w.user_id);
      }
    }

    return res.status(200).json({ received: true, status: newStatus, withdrawal_id: w.id });
  } catch (err) {
    console.error('Send-money webhook error:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
}
