-- 19 October 2026: monthly plans (src/plans.ts, src/stripe.ts). users.plan already exists ('trial').
ALTER TABLE users ADD COLUMN plan_period TEXT;
ALTER TABLE users ADD COLUMN plan_credits INTEGER;
ALTER TABLE users ADD COLUMN plan_until TEXT;
ALTER TABLE users ADD COLUMN plan_status TEXT;
ALTER TABLE users ADD COLUMN plan_sub TEXT;
ALTER TABLE users ADD COLUMN plan_customer TEXT;
ALTER TABLE users ADD COLUMN plan_next_grant TEXT;
CREATE INDEX IF NOT EXISTS users_plan_sub ON users(plan_sub);
