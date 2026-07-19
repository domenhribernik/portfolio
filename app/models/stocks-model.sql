-- Borza: LJSE portfolio tracker (views/stocks). Full rework of the old
-- JSON-file watchlist: instruments and daily prices are synced from the
-- Ljubljana Stock Exchange (see app/services/stocks-sync-service.php), while
-- transactions, announced dividends and Telegram alert rules are user data.
-- Requires auth-model.sql (users, projects) to have been run first.
-- Run manually in phpMyAdmin. Safe to re-run.
--
-- Money is EUR everywhere (LJSE trades in EUR); DECIMAL keeps cents exact.
-- The controller gates every branch with Auth::requireProjectRole('stocks'),
-- so grant a role (e.g. 'investor') to each allowed user; site admins pass
-- implicitly. Per-user tables carry user_id and every write is scoped to it.

-- The tradable universe: LJSE shares and ETFs, seeded below and upserted by
-- the sync whenever the exchange lists something new. segment: A = Prva
-- kotacija, B = Standardna kotacija, E = ETF.
CREATE TABLE IF NOT EXISTS stocks_instruments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(12) NOT NULL UNIQUE,
    isin VARCHAR(12) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    segment CHAR(1) NOT NULL,
    security_type ENUM('share','etf') NOT NULL DEFAULT 'share',
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per instrument per trading day, upserted by the sync (the same day
-- is rewritten while the market is open, so last_price tracks intraday).
CREATE TABLE IF NOT EXISTS stocks_prices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instrument_id INT NOT NULL,
    trade_date DATE NOT NULL,
    open_price DECIMAL(12,4) DEFAULT NULL,
    high_price DECIMAL(12,4) DEFAULT NULL,
    low_price DECIMAL(12,4) DEFAULT NULL,
    last_price DECIMAL(12,4) NOT NULL,
    volume DECIMAL(16,2) DEFAULT NULL,
    turnover DECIMAL(16,2) DEFAULT NULL,
    UNIQUE KEY uq_stocks_price_day (instrument_id, trade_date),
    INDEX idx_stocks_prices_date (trade_date),
    CONSTRAINT fk_stocks_prices_instrument FOREIGN KEY (instrument_id)
        REFERENCES stocks_instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The user's ledger. side 'div' records a received dividend payout:
-- quantity = shares held, price = net dividend per share, fees = 0 usually,
-- so total cash = quantity * price - fees for every side uniformly.
CREATE TABLE IF NOT EXISTS stocks_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    instrument_id INT NOT NULL,
    side ENUM('buy','sell','div') NOT NULL,
    quantity DECIMAL(16,4) NOT NULL,
    price DECIMAL(12,4) NOT NULL,
    fees DECIMAL(10,2) NOT NULL DEFAULT 0,
    trade_date DATE NOT NULL,
    note VARCHAR(200) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_stocks_tx_user (user_id, trade_date),
    CONSTRAINT fk_stocks_tx_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_stocks_tx_instrument FOREIGN KEY (instrument_id)
        REFERENCES stocks_instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Announced dividends (shared reference data, maintained by hand in the view:
-- LJSE has no dividend API). amount is the GROSS per-share figure from the
-- issuer's announcement; the view multiplies by held quantity for estimates.
CREATE TABLE IF NOT EXISTS stocks_dividends (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instrument_id INT NOT NULL,
    ex_date DATE DEFAULT NULL,
    pay_date DATE DEFAULT NULL,
    amount DECIMAL(10,4) NOT NULL,
    note VARCHAR(200) DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_stocks_div_instrument (instrument_id, ex_date),
    CONSTRAINT fk_stocks_div_instrument FOREIGN KEY (instrument_id)
        REFERENCES stocks_instruments(id) ON DELETE CASCADE,
    CONSTRAINT fk_stocks_div_created_by FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Telegram alert rules, evaluated by the sync. kind 'above'/'below' compare
-- last_price to a EUR threshold; 'move' compares the daily change (percent,
-- absolute value) and may leave instrument_id NULL meaning every instrument.
-- last_fired_date throttles each rule to one Telegram message per trading day.
CREATE TABLE IF NOT EXISTS stocks_alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    instrument_id INT DEFAULT NULL,
    kind ENUM('above','below','move') NOT NULL,
    threshold DECIMAL(12,4) NOT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    last_fired_date DATE DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_stocks_alerts_user (user_id),
    CONSTRAINT fk_stocks_alerts_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_stocks_alerts_instrument FOREIGN KEY (instrument_id)
        REFERENCES stocks_instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Register the project so roles can be granted from views/admin.
INSERT INTO projects (project_key, name) VALUES ('stocks', 'Borza LJSE')
ON DUPLICATE KEY UPDATE name = name;

-- Seed the current LJSE universe (July 2026): every listed share (segments A
-- and B) plus every ETF, SLOTR included. The sync keeps this fresh, but the
-- seed makes the view usable before the first sync ever runs.
INSERT INTO stocks_instruments (symbol, isin, name, segment, security_type) VALUES
    ('CICG',  'SI0031103805', 'Cinkarna Celje',                        'A', 'share'),
    ('KRKG',  'SI0031102120', 'Krka',                                  'A', 'share'),
    ('LKPG',  'SI0031101346', 'Luka Koper',                            'A', 'share'),
    ('NLBR',  'SI0021117344', 'NLB',                                   'A', 'share'),
    ('PETG',  'SI0031102153', 'Petrol',                                'A', 'share'),
    ('POSR',  'SI0021110513', 'Sava Re',                               'A', 'share'),
    ('TLSG',  'SI0031104290', 'Telekom Slovenije',                     'A', 'share'),
    ('ZVTG',  'SI0021111651', 'Zavarovalnica Triglav',                 'A', 'share'),
    ('CETG',  'SI0031100843', 'Cetis',                                 'B', 'share'),
    ('EQNX',  'SI0031117813', 'Equinox',                               'B', 'share'),
    ('MKOG',  'SI0031101304', 'Melamin',                               'B', 'share'),
    ('RELR',  'SI0031117995', 'Relax',                                 'B', 'share'),
    ('SALR',  'SI0031110453', 'Salus',                                 'B', 'share'),
    ('SKDR',  'SI0031110164', 'KD',                                    'B', 'share'),
    ('TCRG',  'SI0031100637', 'Terme Čatež',                           'B', 'share'),
    ('UKIG',  'SI0031108994', 'Unior',                                 'B', 'share'),
    ('VZZR',  'SI0031118167', 'Vzajemna',                              'B', 'share'),
    ('SLOTR', 'SI0027400017', 'Ilirika SBITOP TR UCITS ETF',           'E', 'etf'),
    ('ICSLO', 'HRICAMFSBIB2', 'InterCapital SBITOP TR UCITS ETF',      'E', 'etf'),
    ('ICBET', 'HRICAMFBETR5', 'InterCapital BET-TRN UCITS ETF',        'E', 'etf'),
    ('ICCRO', 'HRICAMFC10B6', 'InterCapital CROBEX10tr UCITS ETF',     'E', 'etf'),
    ('ICGRO', 'HRICAMFERGB2', 'InterCapital Romania GovBond UCITS ETF','E', 'etf'),
    ('ICPOL', 'HRICAMFPWIG3', 'InterCapital Poland WIG30TR UCITS ETF', 'E', 'etf'),
    ('ICASH', 'HRICAMFEUMM1', 'InterCapital Euro Money Market UCITS ETF', 'E', 'etf')
ON DUPLICATE KEY UPDATE name = VALUES(name), segment = VALUES(segment),
    security_type = VALUES(security_type);
