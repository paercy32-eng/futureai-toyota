export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { adminId, table, id, updates } = req.body;

    if (!adminId || !table || !id || !updates) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Only allow updates to these tables
    const allowedTables = ['withdrawals', 'users', 'products', 'deposits', 'investments', 'admin_messages', 'gift_codes', 'app_settings'];
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

    // 2. Perform the update
    const updateRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(updates)
      }
    );

    if (!updateRes.ok) {
      const errBody = await updateRes.text();
      console.error('Admin update failed:', errBody);
      return res.status(500).json({ error: 'Update failed', details: errBody });
    }

    const result = await updateRes.json();
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('Admin update handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
