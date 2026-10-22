# Incident repair SQL

`20260917-widen-encrypted-user-names.sql` applies only the name-column widening,
with bounded lock and statement waits. The production repair on 17 September
2026 already applied this DDL after a verified backup and row-content comparison.
Migration `0019_encrypted_unicode_names.sql` records the same change for normal
deployments; it can run after the repair without shrinking or deleting data.

Use normal migrations for new deployments. Do not run unrelated pending
migrations as an incident repair. The old backend required a rolling restart
after the live ALTER to refresh prepared statements. Never narrow these columns
back to 192: valid existing ciphertext can now exceed that size.
