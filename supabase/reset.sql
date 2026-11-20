-- Removes everything schema.sql creates (data included). Photos in the "claims" and
-- "bonus-photos" buckets are NOT deleted by this; empty them in Storage first if you want them gone.
drop policy if exists rider_upload       on storage.objects;
drop policy if exists scorer_upload      on storage.objects;
drop policy if exists scorer_read_photos on storage.objects;
drop policy if exists admin_ref_insert   on storage.objects;
drop policy if exists admin_ref_read     on storage.objects;
drop policy if exists admin_ref_delete   on storage.objects;

drop view if exists claim_activity, rider_activity, claims_detail, rider_scores, approved_effective, approved_direct cascade;
drop table if exists claim_events, claims, combo_members, bonuses, riders, scorers, settings cascade;
drop function if exists
  rider_session(uuid), rider_submit(uuid, uuid, text, text, text, timestamptz), leaderboard(),
  scorer_decide(uuid, claim_status, text), scorer_add_claim(int, text, claim_status, text, text, text),
  scorer_new_token(int), scorer_delete_all_claims(text), scorer_list(), rider_photo_paths(uuid), require_scorer(),
  require_admin(), admin_delete_all(text, text), admin_set_combo(text, text[]), is_admin(), staff_role(),
  claims_before_write(), claims_after_write(), rider_from_token(uuid),
  rider_token_valid(text), is_scorer(), is_combo(text), current_email() cascade;
drop type if exists claim_status cascade;
