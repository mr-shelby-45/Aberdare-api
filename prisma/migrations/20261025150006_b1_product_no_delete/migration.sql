-- Hand-written (Phase B1, approved by Ian): products are archived, never
-- deleted (docs/phase-b-design.md section 2). Spike step 1 granted app_user
-- DELETE on product; take it away so the database enforces the rule, as it
-- already does for location and pack_type. The product_change_log trigger
-- keeps its DELETE branch (a migrator-run cleanup would still be logged).
REVOKE DELETE ON product FROM app_user;
