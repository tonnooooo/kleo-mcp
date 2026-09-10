-- The shared beta code seeded by 0001 (50 uses x 3 credits) was a GATE when invites were the only way in; with the
-- open door it is a GIFT anyone who remembers the string can still collect, on top of the 2 free credits.
-- 0001 is never edited retroactively, so a database rebuilt from the migrations is born with the code already spent.
UPDATE invites SET max_uses = 0 WHERE code = 'KLEO-BETA';
