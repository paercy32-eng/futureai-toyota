export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const payload = req.body;
    console.log('=== MARZPAY COLLECTION WEBHOOK ===');
    console.log(JSON.stringify(payload));

    const event = payload.event_type || payload.event || payload.type || '';
    const data = payload.transaction || payload.data || payload;

    const reference = data.reference || payload.reference || '';
    const status = (data.status || '').toLowerCase();

    console.log('Extracted reference:', reference, 'status:', status, 'event:', event);

    if (!reference) {
      // Always return 200 to stop MarzPay from retrying endlessly
      return res.status(200).json({ received: true, warning: 'No reference found' });
    }

    const isSuccess = event === 'collection.completed' || status === 'completed' || status === 'successful';
    const isFailed = event === 'collection.failed' || status === 'failed' || status === 'cancelled';

    if (!isSuccess && !isFailed) {
      return res.status(200).json({ received: true, ignored: true });
    }

    // Find deposit
    const findRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/deposits?marzpay_reference=eq.${reference}&select=*`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        }
      }
    );
    const deposits = await findRes.json();

    if (!deposits || deposits.length === 0) {
      console.error('No deposit for reference', reference);
      return res.status(200).json({ received: true, warning: 'Deposit not found' });
    }

    const deposit = deposits[0];

    if (deposit.status === 'approved' || deposit.status === 'failed') {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    const newStatus = isSuccess ? 'approved' : 'failed';

    // Update deposit
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/deposits?id=eq.${deposit.id}`, {
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

    // Credit user balance
    if (isSuccess) {
      const userRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${deposit.user_id}&select=balance,total_deposited`,
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
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${deposit.user_id}`, {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            balance: Number(u.balance || 0) + Number(deposit.amount),
            total_deposited: Number(u.total_deposited || 0) + Number(deposit.amount)
          })
        });
        console.log(`Credited ${deposit.amount} to user ${deposit.user_id}`);
      }
    }

    return res.status(200).json({ received: true, status: newStatus });
  } catch (err) {
    console.error('Webhook error:', err);
    // Always return 200 so MarzPay doesn't retry endlessly
    return res.status(200).json({ received: true, error: err.message });
  }
}
