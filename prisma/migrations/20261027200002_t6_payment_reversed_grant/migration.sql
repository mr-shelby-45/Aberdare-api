-- Hand-written (Phase T6): the void sets reversed_txid together with status.
-- app_user may update only status and reversed_txid of a payment.
GRANT UPDATE (reversed_txid) ON payment TO app_user;
