-- migration: 0008_provider_model_route
-- up

-- V2-T02 / V2-MDL-01：Provider 目录来源（platform=远程目录/配置源创建，custom=用户手建）。
-- 历史行无法区分当初是否来自远程配置，一律如实记 custom，不猜。
ALTER TABLE provider ADD COLUMN source TEXT NOT NULL DEFAULT 'custom';

-- V2-MDL-02：模型复合路由身份。
-- provider_model_id = provider_id || ':' || name，是唯一路由句柄；
-- canonical_vendor / canonical_model 是官方身份（T17 查官方价用），可空、不参与路由。
ALTER TABLE model ADD COLUMN provider_model_id TEXT NULL;
ALTER TABLE model ADD COLUMN canonical_vendor TEXT NULL;
ALTER TABLE model ADD COLUMN canonical_model TEXT NULL;

UPDATE model SET provider_model_id = provider_id || ':' || name;

-- 同一 Provider 内同名模型 = 同一条路由的重复行（历史缺陷可能经 addManualModel 重复添加），
-- 合并到最早一行；usage_record / ai_model_config 的引用精确改指存活行（同 Provider 同名是
-- 同一路由，属精确映射，不是按名字猜测）。跨 Provider 的同名模型绝不合并。
CREATE TEMP TABLE model_dup_map AS
SELECT dup.id AS dup_id,
       (
         SELECT keeper.id FROM model keeper
          WHERE keeper.provider_id = dup.provider_id
            AND keeper.name = dup.name
          ORDER BY keeper.created_at ASC, keeper.id ASC
          LIMIT 1
       ) AS keep_id
FROM model dup
WHERE EXISTS (
  SELECT 1 FROM model other
   WHERE other.provider_id = dup.provider_id
     AND other.name = dup.name
     AND (other.created_at < dup.created_at
          OR (other.created_at = dup.created_at AND other.id < dup.id))
);

UPDATE usage_record
   SET model_id = (SELECT keep_id FROM model_dup_map WHERE dup_id = usage_record.model_id)
 WHERE model_id IN (SELECT dup_id FROM model_dup_map);

UPDATE ai_model_config
   SET default_model_id = COALESCE(
         (SELECT keep_id FROM model_dup_map WHERE dup_id = ai_model_config.default_model_id),
         ai_model_config.default_model_id
       );

-- 用途绑定 JSON 的值是 model 行 ID：把指向重复行的值改指存活行（ULID 全库唯一，文本替换安全）。
UPDATE ai_model_config
   SET purpose_bindings_json = (
         SELECT COALESCE(json_group_object(je.key, COALESCE(map.keep_id, je.value)), '{}')
           FROM json_each(ai_model_config.purpose_bindings_json) je
           LEFT JOIN model_dup_map map ON map.dup_id = je.value
       )
 WHERE EXISTS (
   SELECT 1 FROM json_each(ai_model_config.purpose_bindings_json) je
    JOIN model_dup_map map ON map.dup_id = je.value
 );

DELETE FROM model WHERE id IN (SELECT dup_id FROM model_dup_map);
DROP TABLE model_dup_map;

-- 路由唯一性由数据库最终把关：同一 Provider 内模型名唯一，复合路由键唯一。
CREATE UNIQUE INDEX idx_model_provider_name ON model (provider_id, name);
CREATE UNIQUE INDEX idx_model_provider_model_id ON model (provider_model_id);

-- down

-- 回退移除 0008 的 schema；历史重复行已按同路由合并、引用已精确改指，
-- 这些行不会（也不应）在回退时复活——跨 Provider 的同名模型始终未被合并。
DROP INDEX IF EXISTS idx_model_provider_model_id;
DROP INDEX IF EXISTS idx_model_provider_name;
ALTER TABLE model DROP COLUMN canonical_model;
ALTER TABLE model DROP COLUMN canonical_vendor;
ALTER TABLE model DROP COLUMN provider_model_id;
ALTER TABLE provider DROP COLUMN source;
