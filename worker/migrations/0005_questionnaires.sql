CREATE TABLE questionnaire_versions(version INTEGER PRIMARY KEY, questions TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
INSERT INTO questionnaire_versions VALUES(0,'[{"id":"giveCurrency","type":"core","label":"Что отдаёте?","required":true},{"id":"amount","type":"core","label":"Какую сумму меняем?","required":true},{"id":"receiveCurrency","type":"core","label":"Что получаете?","required":true},{"id":"method","type":"core","label":"Как проведём обмен?","required":true}]',8321831931,datetime('now'));
CREATE TRIGGER questionnaire_versions_no_update BEFORE UPDATE ON questionnaire_versions BEGIN SELECT RAISE(ABORT,'Published forms are immutable'); END;
CREATE TRIGGER questionnaire_versions_no_delete BEFORE DELETE ON questionnaire_versions BEGIN SELECT RAISE(ABORT,'Published forms are immutable'); END;
CREATE TABLE questionnaire_sessions(id TEXT PRIMARY KEY,telegram_id INTEGER NOT NULL,version INTEGER NOT NULL REFERENCES questionnaire_versions(version),expires_at TEXT NOT NULL);
CREATE TABLE questionnaire_writes(id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
ALTER TABLE deals ADD COLUMN questionnaire_snapshot TEXT;
