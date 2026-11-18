// Supabase Edge Function: lets a rider see the photos they submitted.
//
// POST { token, paths? }  ->  { photos: { "<photo path>": "/storage/v1/object/sign/..." } }
//
// The "claims" bucket stays private and riders have no storage read rule. This function checks the
// rider link (token) in the database, then signs only the photos that belong to that rider's claims
// (including photos rally staff added for them). Links last one hour.
//
// Signed links are returned WITHOUT the host: inside local Supabase the function sees an internal
// address, so the page puts its own SUPABASE_URL in front.
//
// Deploy without JWT verification (the rider token is the check; the anon key is public anyway):
//   npx supabase functions deploy rider-photo --no-verify-jwt --project-ref <ref>
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const BAD_LINK = 'This rider link is not valid. Ask the rally staff for a new one.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ message: 'Use POST.' }, 405);

  let body: { token?: unknown; paths?: unknown };
  try { body = await req.json(); } catch { return reply({ message: 'Bad request.' }, 400); }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!/^[0-9a-fA-F-]{36}$/.test(token)) return reply({ message: BAD_LINK }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Which photos belong to this rider (raises "not valid" for an unknown token)
  const { data: owned, error } = await sb.rpc('rider_photo_paths', { p_token: token });
  if (error) return reply({ message: /not valid/.test(error.message) ? BAD_LINK : 'Could not look up photos.' }, 400);

  let wanted: string[] = Array.isArray(owned) ? owned : [];
  if (Array.isArray(body.paths)) {
    const asked = new Set(body.paths.filter((p): p is string => typeof p === 'string'));
    wanted = wanted.filter((p) => asked.has(p));
  }
  if (!wanted.length) return reply({ photos: {} });

  const { data: signed, error: signError } = await sb.storage.from('claims').createSignedUrls(wanted, 3600);
  if (signError) return reply({ message: 'Could not prepare photos.' }, 500);

  const photos: Record<string, string> = {};
  for (const s of signed ?? []) {
    if (!s.path || !s.signedUrl) continue;   // missing file: skip it, the page says "not found"
    const u = new URL(s.signedUrl);
    photos[s.path] = u.pathname + u.search;
  }
  return reply({ photos });
});
