export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { adminId, table, query } = req.body;

    if (!adminId || !table) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const allowedTables = ['withdrawals', 'users', 'products', 'deposits', 'investments', 'admin_messages', 'gift_codes', 'app_settings', 'referral_earnings', 'reward_claims'];
    if (!allowedTables.includes(table)) {
      return res.status(400).json({ error: 'Table not allowed' });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: 'Service role key not configured' });
    }

    // 1. Verify the caller is an admin
    const adminCheck = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${adminId}&select=is_admin`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`
        }
      }
    );
    const adminRows = await adminCheck.json();
    if (!adminRows || adminRows.length === 0 || !adminRows[0].is_admin) {
      return res.status(403).json({ error: 'Only admins can do this' });
    }

    // 2. Fetch the data with the query string provided
    const queryString = query || 'select=*';
    const readRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/${table}?${queryString}`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`
        }
      }
    );

    if (!readRes.ok) {
      const errBody = await readRes.text();
      console.error('Admin read failed:', errBody);
      return res.status(500).json({ error: 'Read failed', details: errBody });
    }

    const result = await readRes.json();
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('Admin read handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
