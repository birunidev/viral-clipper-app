#!/usr/bin/env bash
set -e
# Seed 5 unlimited desktop licenses into local docker dev db (clipforge-dev-db:5438)
# Usage: ./scripts/seed-dev-licenses.sh
DB_URL="${DATABASE_URL:-postgresql://clipforge:clipforge@localhost:5438/clipforge}"
echo "Seeding licenses into $DB_URL ..."
docker exec clipforge-dev-db psql -U clipforge -d clipforge -c "
INSERT INTO licenses (id, license_key, email, user_id, is_valid, tier) VALUES
('lic_seed_001', 'CF-DEV-LOCAL-UNLIMITED-001', 'birunidev@gmail.com', (SELECT id FROM users WHERE email='birunidev@gmail.com' LIMIT 1), true, 'unlimited'),
('lic_seed_002', 'CF-TEST-WIN-002-UNLIMITED', 'test-win@clipforge.local', (SELECT id FROM users WHERE email='birunidev@gmail.com' LIMIT 1), true, 'unlimited'),
('lic_seed_003', 'CF-TEST-MAC-003-UNLIMITED', 'test-mac@clipforge.local', (SELECT id FROM users WHERE email='birunidev@gmail.com' LIMIT 1), true, 'unlimited'),
('lic_seed_004', 'CF-TEST-LINUX-004-UNLIMITED', 'test-linux@clipforge.local', (SELECT id FROM users WHERE email='birunidev@gmail.com' LIMIT 1), true, 'unlimited'),
('lic_seed_005', 'CF-DEV-CI-005-UNLIMITED', 'ci@clipforge.local', (SELECT id FROM users WHERE email='birunidev@gmail.com' LIMIT 1), true, 'unlimited')
ON CONFLICT (license_key) DO UPDATE SET is_valid=true, tier='unlimited';
SELECT license_key, email, is_valid, tier FROM licenses;
"
echo "Done. Use one of these in desktop: CF-DEV-LOCAL-UNLIMITED-001 etc."
echo "For local test, set LICENSE_VERIFY_URL=http://localhost:8000/api/v1/license/verify  or http://localhost:3005/api/license/verify"
