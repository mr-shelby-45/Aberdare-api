-- Hand-written (Phase F1, docs/phase-f-design.md section 3): device.push_token
-- exists since Phase A1 (unused until now). The smallest change: app_user may
-- also update that one column, so a dead token can be cleared (F3).
GRANT UPDATE (push_token) ON device TO app_user;
