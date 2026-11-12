// Supabase connection for the pages.
// Committed values point at local Supabase (`npx supabase start`; `npx supabase status` shows them).
// The anon key is meant to be public; the database rules decide what it can do.
// The hosted site does not use this file as is: the Netlify build overwrites it from the
// SUPABASE_URL and SUPABASE_ANON_KEY environment variables (see netlify.toml).
// To point a local copy at a hosted project instead, use Supabase -> Project Settings -> API.
export const SUPABASE_URL = 'http://127.0.0.1:54321';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
