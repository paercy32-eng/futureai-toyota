export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    console.log('MarzPay webhook received:', JSON.stringify(payload));

    // Extract fields — MarzPay may send variations
    const event = payload.event || payload.type || '';
    const data = payload.data || payload;

    const reference = data.reference || data.collection_reference || '';
    const status = (data.status || '').toLowerCase();
    const providerTxId = data.provider_transaction_id || data.transaction_id || '';
    const amount = Number(data.amount || 0);

    if (!reference) {
      console.error('No reference in webhook payload');
      return res.status(400).json({ error: 'Missing reference' });
    }

    // Determine if this is a final successful or failed event
    const isSuccess =
      event === 'collection.completed' ||
      status === 'completed' ||
      status === 'successful' ||
      status === 'success';

    const isFailed =
      event === 'collection.failed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'declined';

    if (!isSuccess && !isFailed) {
      console.log('Not a final status, ignoring:', status, event);
      return res.status(200).json({ received: true, ignored: true });
    }

    // Find the deposit row in Supabase
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
      console.error('No matching deposit found for reference:', reference);
      return res.status(404).json({ error: 'Deposit not found' });
    }

    const deposit = deposits[0];

    // If already processed, ignore
    if (deposit.status === 'approved' || deposit.status === 'failed') {
      console.log('Deposit already processed:', deposit.status);
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    const newStatus = isSuccess ? 'approved' : 'failed';

    // Update deposit status
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
        marzpay_uuid: providerTxId || deposit.marzpay_uuid,
        completed_at: new Date().toISOString(),
        raw_response: payload
      })
    });

    // If successful, credit the user's balance
    if (isSuccess) {
      const userId = deposit.user_id;
      const depositAmount = Number(deposit.amount);

      // Get current user
      const userRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=balance,total_deposited`,
        {
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
          }
        }
      );
      const users = await userRes.json();

      if (users && users.length > 0) {
        const currentBalance = Number(users[0].balance || 0);
        const currentTotalDeposited = Number(users[0].total_deposited || 0);
        const newBalance = currentBalance + depositAmount;
        const newTotalDeposited = currentTotalDeposited + depositAmount;

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            balance: newBalance,
            total_deposited: newTotalDeposited
          })
        });

        console.log(`✅ Credited ${depositAmount} UGX to user ${userId}. New balance: ${newBalance}`);
      }
    } else {
      console.log(`❌ Deposit failed for user ${deposit.user_id}, reference ${reference}`);
    }

    return res.status(200).json({ received: true, status: newStatus });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message || 'Webhook handler error' });
  }
    }
