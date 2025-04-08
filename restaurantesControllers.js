// controllers/restaurantesController.js
const pool = require('/Users/agusr/Desktop/Ing-Software-II/db.js');

const obtenerRestaurantes = async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM restaurantes');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error del servidor' });
  }
};

module.exports = { obtenerRestaurantes };
