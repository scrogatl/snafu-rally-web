-- Removes everything schema.sql creates (data included). Photos in the "claims"
-- bucket are NOT deleted by this; empty the bucket in Storage first if you want them gone.
drop policy if exists rider_upload       on storage.objects;
drop policy if exists scorer_upload      on storage.objects;
drop policy if exists scorer_read_photos on storage.objects;

drop view if exists claims_detail, rider_scores, approved_effective, approved_direct cascade;
drop table if exists claim_events, claims, combo_members, bonuses, riders, scorers, settings cascade;
drop function if exists
  rider_session(uuid), rider_submit(uuid, uuid, text, text, text, timestamptz), leaderboard(),
  scorer_decide(uuid, claim_status, text), scorer_add_claim(int, text, claim_status, text, text, text),
  scorer_new_token(int), scorer_delete_all_claims(text), require_scorer(),
  claims_before_write(), claims_after_write(), rider_from_token(uuid),
  rider_token_valid(text), is_scorer(), is_combo(text), current_email() cascade;
drop type if exists claim_status cascade;
