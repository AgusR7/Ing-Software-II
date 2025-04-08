// server.js
const express = require('express');
const cors = require('cors');
const restaurantesRoutes = require('/Users/agusr/Desktop/Ing-Software-II/routes/restaurantesRoutes.js');

const app = express();
app.use(express.json());
app.use(cors());

app.use('/api/restaurantes', restaurantesRoutes);

app.listen(3001, () => {
  console.log('Servidor corriendo en puerto 3001');
});
