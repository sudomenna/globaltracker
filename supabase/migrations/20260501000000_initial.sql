-- Migration zero: extensions base
-- Nao cria tabelas -- schemas de dominio vem no Sprint 1+

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
