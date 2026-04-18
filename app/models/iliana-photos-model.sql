CREATE TABLE IF NOT EXISTS iliana_photos (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    image_id   INT NOT NULL,
    caption    VARCHAR(500) NOT NULL,
    photo_date DATE NOT NULL,
    added_by   ENUM('Domen', 'Iliana') NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_iliana_photos_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    INDEX idx_photo_date (photo_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

const photos = [
    {
        src: '../../assets/iliana/moviepark.jpg',
        date: 'Jun 20, 2025',
        caption: 'Movie park was so fun!!!'
    },
    {
        src: '../../assets/iliana/colone.jpg',
        date: 'Jun 21, 2025',
        caption: 'Trip to Cologne and Düsseldorf :)'
    },
    {
        src: '../../assets/iliana/onemonth.jpg',
        date: 'Jul 18, 2025',
        caption: 'One month anniversary <3'
    },
    {
        src: '../../assets/iliana/iliana-and-sup.jpg',
        date: 'Aug 31, 2025',
        caption: 'You, sup and sunset :)'
    },
    {
        src: '../../assets/iliana/tavli.jpg',
        date: 'Sep 1, 2025',
        caption: 'That time I beat you in tavli :P'
    },
    {
        src: '../../assets/iliana/seafood-dinner.jpg',
        date: 'Sep 2, 2025',
        caption: 'Seafood dinner date!'
    },
    {
        src: '../../assets/iliana/xanthe-gyro.jpg',
        date: 'Sep 3, 2025',
        caption: 'Best gyros in Greece!'
    },
    {
        src: '../../assets/iliana/beach-dinner.jpg',
        date: 'Sep 4, 2025',
        caption: 'Most romantic beach date ever <3'
    },
    {
        src: '../../assets/iliana/komotini-selfie.jpg',
        date: 'Sep 5, 2025',
        caption: 'Komotini was the best :D'
    },
    {
        src: '../../assets/iliana/saloniki-selfie.jpg',
        date: 'Sep 6, 2025',
        caption: 'Our trip to Thessaloniki :)'
    },
    {
        src: '../../assets/iliana/saloniki-appartment.jpg',
        date: 'Sep 6, 2025',
        caption: 'We had such a cool appartment :O'
    },
    {
        src: '../../assets/iliana/castle-cat.jpg',
        date: 'Sep 7, 2025',
        caption: 'You met a new friend :D'
    },
    {
        src: '../../assets/iliana/cuddles-at-home.jpg',
        date: 'Oct 26, 2025',
        caption: 'Watching the office in your room <3'
    },
    {
        src: '../../assets/iliana/moviepark-part2.jpg',
        date: 'Oct 28, 2025',
        caption: 'Movie park but scary ;)'
    },
    {
        src: '../../assets/iliana/daisy-movie-park.jpg',
        date: 'Oct 28, 2025',
        caption: 'Remember when we addopted Daisy? :P'
    },
    {
        src: '../../assets/iliana/best-burgers-in-germany.jpg',
        date: 'Oct 30, 2025',
        caption: 'Best burgers in town!'
    },
    {
        src: '../../assets/iliana/skocijan-cave-view-2025.jpg',
        date: 'Oct 30, 2025',
        caption: 'Trip to Škocijan Caves :O'
    },
    {
        src: '../../assets/iliana/triest-trip-pizza-2025.jpg',
        date: 'Oct 30, 2025',
        caption: 'And for dinner pizza in Italy :)'
    },
    {
        src: '../../assets/iliana/nature-hike-2025.jpg',
        date: 'Oct 31, 2025',
        caption: 'Reconnecting with nature <3'
    },
    {
        src: '../../assets/iliana/bled-trip-slo-2025.jpg',
        date: 'Nov 1, 2025',
        caption: 'Bled trip :)'
    },
    {
        src: '../../assets/iliana/slap-savica-2025.jpg',
        date: 'Nov 1, 2025',
        caption: 'Slap Savica waterfall :D'
    },
    {
        src: '../../assets/iliana/horse-racing-lopata-2025.jpg',
        date: 'Nov 2, 2025',
        caption: 'We went to a horse race!'
    },
    {
        src: '../../assets/iliana/tomatoes-from-the-garden-2025.jpg',
        date: 'Nov 4, 2025',
        caption: 'Fresh tomatoes from the garden :)'
    },
    {
        src: '../../assets/iliana/luna-pet-ljubljana-2025.jpg',
        date: 'Nov 8, 2025',
        caption: 'Meeting Luna in Ljubljana!'
    },
    {
        src: '../../assets/iliana/hose-of-ilusions-ljubljana-2025.jpg',
        date: 'Nov 8, 2025',
        caption: 'House of illusions was so fun :p'
    },
    {
        src: '../../assets/iliana/home-made-pizza-2025.jpg',
        date: 'Nov 9, 2025',
        caption: 'Home made pizza for lunch :)'
    },
    {
        src: '../../assets/iliana/spa-olimije-2025.jpg',
        date: 'Nov 10, 2025',
        caption: 'Chilling at a Spa :D'
    },
    {
        src: '../../assets/iliana/hungry-twiggy-2025.jpg',
        date: 'Nov 11, 2025',
        caption: 'I know you have food >:)'
    }