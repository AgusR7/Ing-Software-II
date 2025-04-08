// routes/restaurantesRoutes.js
const express = require('express');
const router = express.Router();
const { obtenerRestaurantes } = require('/Users/agusr/Desktop/Ing-Software-II/controllers/restaurantesControllers.js');

router.get('/', obtenerRestaurantes);

module.exports = router;
