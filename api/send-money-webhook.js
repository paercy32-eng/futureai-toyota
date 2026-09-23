export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};
    console.log('=== SEND-MONEY WEBHOOK RECEIVED ===');
    console.log(JSON.stringify(payload));

    // Extract event type and transaction data
    const eventType = payload.event_type || payload.event || payload.type || '';
    const tx = payload.transaction || payload.data || payload;
    const reference = tx.reference || payload.reference || '';
    const status = String(tx.status || '').toLowerCase();

    console.log('Event:', eventType, '| Reference:', reference, '| Status:', status);

    if (!reference) {
      console.log('No reference found in payload');
      return res.status(200).json({ received: true, warning: 'No reference' });
    }

    // Determine final status
    const isSuccess =
      eventType === 'disbursement.completed' ||
      eventType === 'send_money.completed' ||
      status === 'completed' ||
      status === 'successful' ||
      status === 'success';

    const isFailed =
      eventType === 'disbursement.failed' ||
      eventType === 'send_money.failed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'rejected';

    if (!isSuccess && !isFailed) {
      console.log('Not a final status, ignoring');
      return res.status(200).json({ received: true, ignored: true });
    }

    // Find the matching withdrawal
    const findRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/withdrawals?marzpay_reference=eq.${reference}&select=*`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        }
      }
    );

    if (!findRes.ok) {
      console.error('Failed to query withdrawals:', await findRes.text());
      return res.status(200).json({ received: true, error: 'DB query failed' });
    }

    const rows = await findRes.json();

    if (!rows || rows.length === 0) {
      console.log('No withdrawal found for reference:', reference);
      return res.status(200).json({ received: true, warning: 'Withdrawal not found' });
    }

    const w = rows[0];

    if (w.status === 'completed' || w.status === 'failed') {
      console.log('Withdrawal already processed:', w.status);
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    const newStatus = isSuccess ? 'completed' : 'failed';

    // Update the withdrawal
    const updateRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/withdrawals?id=eq.${w.id}`,
      {
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
      }
    );

    if (!updateRes.ok) {
      console.error('Failed to update withdrawal:', await updateRes.text());
    } else {
      console.log('Withdrawal', w.id, 'marked as', newStatus);
    }

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

      if (userRes.ok) {
        const users = await userRes.json();
        if (users && users.length > 0) {
          const u = users[0];
          const refundedBalance = Number(u.balance || 0) + Number(w.amount || 0);
          const refundedTotal = Math.max(Number(u.total_withdrawn || 0) - Number(w.amount || 0), 0);

          await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${w.user_id}`, {
            method: 'PATCH',
            headers: {
              'apikey': process.env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              balance: refundedBalance,
              total_withdrawn: refundedTotal
            })
          });
          console.log('Refunded', w.amount, 'to user', w.user_id);
        }
      }
    }

    return res.status(200).json({ received: true, status: newStatus });
  } catch (err) {
    console.error('Send-money webhook error:', err);
    // Always return 200 to stop MarzPay from retrying
    return res.status(200).json({ received: true, error: err.message });
  }
}
