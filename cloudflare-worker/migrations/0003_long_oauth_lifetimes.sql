-- Existing seeded resource rows retain their old limits unless migrated.
-- Change only ResearchTube production and default local resource policies.
UPDATE "oauthResource"
SET "accessTokenTtl" = 315360000, "refreshTokenTtl" = 315360000
WHERE "identifier" IN ('https://rtube.win', 'http://localhost:8787');
