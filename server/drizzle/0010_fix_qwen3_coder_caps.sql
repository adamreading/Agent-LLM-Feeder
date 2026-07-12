-- Fix qwen3-coder missing tools and json_mode capabilities
-- Verified working via live tests on 2026-07-12
-- Issue: Under-probed; capabilities present but not recorded in DB

INSERT INTO model_capabilities (model_id, capability, supported, measured_at, source)
SELECT id, 'tools', true, NOW(), 'measured' FROM canonical_models WHERE slug = 'qwen3-coder'
WHERE NOT EXISTS (
  SELECT 1 FROM model_capabilities WHERE model_id = (SELECT id FROM canonical_models WHERE slug = 'qwen3-coder') AND capability = 'tools'
)
UNION ALL
SELECT id, 'json_mode', true, NOW(), 'measured' FROM canonical_models WHERE slug = 'qwen3-coder'
WHERE NOT EXISTS (
  SELECT 1 FROM model_capabilities WHERE model_id = (SELECT id FROM canonical_models WHERE slug = 'qwen3-coder') AND capability = 'json_mode'
);

-- If rows already exist but are marked false, update them
UPDATE model_capabilities
SET supported = true, measured_at = NOW(), source = 'measured'
WHERE model_id = (SELECT id FROM canonical_models WHERE slug = 'qwen3-coder')
  AND capability IN ('tools', 'json_mode')
  AND supported = false;
