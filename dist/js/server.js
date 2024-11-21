const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = 3000;

app.get('/quote', async (req, res) => {
    try {
        const response = await fetch("https://api.quotable.io/random");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch quote" });
    }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
