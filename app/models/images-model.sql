
CREATE TABLE IF NOT EXISTS images (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    uuid          CHAR(36)     NOT NULL UNIQUE,
    folder        VARCHAR(100) NOT NULL DEFAULT 'general',
    original_name VARCHAR(255),                           
    mime_type     VARCHAR(50),                            
    width         INT,                                    
    height        INT,                                    
    file_size     INT,                                    
    uploaded_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_images_folder ON images (folder);
