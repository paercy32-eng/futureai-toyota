export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Allow GET (from cron) and POST (from admin panel or manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Use service-time now
    const nowIso = new Date().toISOString();

    // 1. Find all active daily investments that are due
    const findRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/investments?status=eq.active&earning_type=eq.daily&next_payout_at=lte.${nowIso}&select=*`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        }
      }
    );

    if (!findRes.ok) {
      const err = await findRes.text();
      console.error('Failed to fetch due investments:', err);
      return res.status(500).json({ error: 'Failed to fetch due investments', details: err });
    }

    const due = await findRes.json();
    console.log(`Found ${due.length} investments due for payout`);

    const results = [];

    for (const inv of due) {
      try {
        const payoutAmount = Number(inv.daily_earning || 0);
        if (payoutAmount <= 0) {
          results.push({ id: inv.id, skipped: 'daily_earning is 0' });
          continue;
        }

        // Calculate next dates
        const currentNext = new Date(inv.next_payout_at);
        const nextPayout = new Date(currentNext.getTime() + 24 * 60 * 60 * 1000);
        const newDaysCredited = Number(inv.days_credited || 0) + 1;
        const totalDays = Number(inv.earning_days || 0);
        const newTotalEarned = Number(inv.total_earned || 0) + payoutAmount;
        const isComplete = totalDays > 0 && newDaysCredited >= totalDays;

        // 2. Credit user's balance
        const userRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${inv.user_id}&select=balance,total_earned`,
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
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${inv.user_id}`, {
            method: 'PATCH',
            headers: {
              'apikey': process.env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              balance: Number(u.balance || 0) + payoutAmount,
              total_earned: Number(u.total_earned || 0) + payoutAmount
            })
          });
        }

        // 3. Update the investment
        const updatePayload = {
          days_credited: newDaysCredited,
          total_earned: newTotalEarned,
          next_payout_at: nextPayout.toISOString()
        };
        if (isComplete) updatePayload.status = 'completed';

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/investments?id=eq.${inv.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(updatePayload)
        });

        results.push({
          id: inv.id,
          user_id: inv.user_id,
          amount: payoutAmount,
          days_credited: newDaysCredited,
          completed: isComplete
        });
      } catch (invErr) {
        console.error('Error processing investment', inv.id, invErr);
        results.push({ id: inv.id, error: invErr.message });
      }
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results
    });
  } catch (err) {
    console.error('Daily payout handler error:', err);
    return res.status(500).json({ error: err.message });
  }
      }
