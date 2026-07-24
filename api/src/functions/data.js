const { app } = require('@azure/functions');
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.PG_CONNECTION,
      ssl: { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 30000
    });
  }
  return pool;
}

const WRITABLE = new Set(['buildings', 'rooms', 'lots', 'drivers', 'entries']);
const COLUMNS = {
  buildings: ['name', 'sort_order'],
  rooms:     ['name', 'building_id', 'row_count', 'col_count', 'locked', 'layout'],
  lots:      ['lot_number', 'variety', 'grower', 'active'],
  drivers:   ['name', 'active'],
  entries:   ['room_id', 'col', 'row', 'lines', 'driver', 'client_id', 'undone']
};
function pick(table, obj) {
  const out = {};
  for (const k of (COLUMNS[table] || [])) if (k in obj) out[k] = obj[k];
  return out;
}
const JH = { 'Content-Type': 'application/json' };
const ok  = (b) => ({ status: 200, headers: JH, body: JSON.stringify(b) });
const bad = (m, c = 400) => ({ status: c, headers: JH, body: JSON.stringify({ error: m }) });

app.http('data', {
  route: 'data/{action}',
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',   // Static Web Apps enforces auth in front of this
  handler: async (req, ctx) => {
    const action = req.params.action;
    try {
      const db = getPool();

      if (action === 'load' && req.method === 'GET') {
        const [buildings, rooms, lots, drivers, cmap] = await Promise.all([
          db.query('select id,name,sort_order from buildings order by sort_order,name'),
          db.query('select id,name,building_id,row_count,col_count,locked,layout from rooms order by name'),
          db.query('select id,lot_number,variety,grower from lots where active=true order by lot_number'),
          db.query('select id,name from drivers where active=true order by name'),
          db.query('select id,room,building,col,row,lines,driver,created_at from current_map')
        ]);
        return ok({ buildings: buildings.rows, rooms: rooms.rows, lots: lots.rows,
                    drivers: drivers.rows, current_map: cmap.rows });
      }

      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

      if (action === 'insert' && req.method === 'POST') {
        const table = body.table;
        if (!WRITABLE.has(table)) return bad('table not allowed');
        const rows = Array.isArray(body.rows) ? body.rows : [body.row];
        if (!rows.length || !rows[0]) return bad('no rows');
        const results = [];
        for (const raw of rows) {
          const r = pick(table, raw);
          const keys = Object.keys(r);
          if (!keys.length) continue;
          const cols = keys.map(k => `"${k}"`).join(',');
          const params = keys.map((_, i) => `$${i + 1}`).join(',');
          const vals = keys.map(k => {
            const v = r[k];
            return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
          });
          const conflict =
            table === 'entries'   ? 'on conflict (client_id) do nothing' :
            table === 'rooms'     ? 'on conflict (name) do update set building_id=excluded.building_id, row_count=excluded.row_count, col_count=excluded.col_count, locked=excluded.locked, layout=excluded.layout' :
            table === 'lots'      ? 'on conflict (lot_number) do update set variety=excluded.variety, grower=excluded.grower, active=excluded.active' :
            table === 'buildings' ? 'on conflict (name) do nothing' :
            table === 'drivers'   ? 'on conflict (name) do update set active=excluded.active' : '';
          const res = await db.query(
            `insert into ${table} (${cols}) values (${params}) ${conflict} returning *`, vals);
          if (res.rows[0]) results.push(res.rows[0]);
        }
        return ok(results);
      }

      if (action === 'update' && req.method === 'POST') {
        const table = body.table;
        if (!WRITABLE.has(table)) return bad('table not allowed');
        if (!body.id) return bad('id required');
        const r = pick(table, body.set || {});
        const keys = Object.keys(r);
        if (!keys.length) return bad('nothing to update');
        const sets = keys.map((k, i) => `"${k}"=$${i + 1}`).join(',');
        const vals = keys.map(k => {
          const v = r[k];
          return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        });
        vals.push(body.id);
        const res = await db.query(
          `update ${table} set ${sets} where id=$${keys.length + 1} returning *`, vals);
        return ok(res.rows);
      }

      if (action === 'delete' && req.method === 'POST') {
        const table = body.table;
        if (!WRITABLE.has(table) || table === 'entries') return bad('delete not allowed for this table');
        if (!body.id) return bad('id required');
        await db.query(`delete from ${table} where id=$1`, [body.id]);
        return ok({ deleted: body.id });
      }

      return bad('unknown action: ' + action, 404);
    } catch (err) {
      ctx.error(err);
      return bad('server error: ' + err.message, 500);
    }
  }
});
