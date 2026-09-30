export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { adminId, userId, newPassword } = req.body;

    if (!adminId || !userId || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
      return res.status(403).json({ error: 'Only admins can reset passwords' });
    }

    // 2. Reset the password via Supabase Admin API
    const updateRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        method: 'PUT',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: newPassword })
      }
    );

    if (!updateRes.ok) {
      const errBody = await updateRes.text();
      console.error('Supabase admin reset failed:', errBody);
      return res.status(500).json({ error: 'Password reset failed', details: errBody });
    }

    return res.status(200).json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
