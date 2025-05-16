import { Request, Response } from 'express';
import { db } from '../db';
import { io } from '../sockets/occupancySocket';
import { sendReservationConfirmationEmail, sendReservationCancellationEmail } from '../utils/mailer'; // Updated import

export const createReservation = async (req: Request, res: Response) => {
  const user = req.user as { id: number; email: string } | undefined;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { restaurant_id, reservation_at, guests } = req.body;
  // start time sent as epoch ms from client
  const start = new Date(reservation_at);
  // Validar que la fecha no sea en el pasado
  if (start < new Date()) {
    return res.status(400).json({ error: 'No se puede hacer una reserva en el pasado.' });
  }
  // round to even number of seats
  const requestedGuests = Number(guests);
  const assignedGuests = requestedGuests % 2 ? requestedGuests + 1 : requestedGuests;
  const OPEN_HOUR = 10, CLOSE_HOUR = 23, LAST_MINUTE = 30;
  // El epoch viene en UTC; lo convertimos a hora local (UTC-3)
  const startUtc = new Date(reservation_at);
  const localHour     = (startUtc.getUTCHours() + 24 - 3) % 24;   // 0-23
  const localMinutes  =  startUtc.getUTCMinutes();
  if (
    localHour < OPEN_HOUR ||
    localHour > CLOSE_HOUR ||
    (localHour === CLOSE_HOUR && localMinutes > LAST_MINUTE)
  ) {
    return res.status(400).json({ error: 'Invalid reservation time' });
  }
  const end = new Date(start.getTime() + 90 * 60000); // 1h30
  const client = await db.connect();
  try {
    // get restaurant capacity
    const { rows: restRows } = await client.query(
      'SELECT seats_total, name FROM restaurants WHERE id=$1',
      [restaurant_id]
    );
    if (!restRows.length) return res.status(404).json({ error: 'Restaurant not found' });
    const { seats_total, name: restaurantName } = restRows[0];
    // calculate used tables in overlapping reservations
    const { rows: usedRows } = await client.query(
      `SELECT COALESCE(SUM((guests + 1)/2),0)::int AS used_tables
       FROM reservations
       WHERE restaurant_id=$1
         AND status IN ('pending','confirmed')
         AND reservation_at < $3
         AND reservation_at + INTERVAL '90 minutes' > $2`,
      [restaurant_id, start, end]
    );
    const usedTables = usedRows[0].used_tables;
    const tablesTotal = Math.floor(seats_total / 2);
    const neededTables = Math.ceil(requestedGuests / 2);
    if (tablesTotal - usedTables < neededTables) {
      return res.status(400).json({ error: 'Not enough tables in selected interval' });
    }
    // insert reservation
    await client.query(
      'INSERT INTO reservations (user_id, restaurant_id, reservation_at, requested_guests, guests) VALUES ($1,$2,$3,$4,$5)',
      [user.id, restaurant_id, start, requestedGuests, assignedGuests]
    );
    // notification email
    try {
      // Use the new function for sending confirmation email
      await sendReservationConfirmationEmail(
        user.email,
        restaurantName,
        requestedGuests, // Changed from assignedGuests to requestedGuests
        reservation_at
      );
    } catch (mailErr) {
      console.error('Mail error', mailErr);
    }

    // Emit socket event
    io.to(`restaurant_${restaurant_id}`).emit('occupancy_update', { restaurant_id });

    res.status(201).json({ message: 'Reservation confirmed', requested_guests: requestedGuests, guests: assignedGuests, reservation_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};

export const getReservations = async (req: Request, res: Response) => {
  const user = req.user as { id: number } | undefined;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { rows } = await db.query(
      `SELECT r.id, r.restaurant_id, rest.name AS restaurant_name,
              r.reservation_at, r.requested_guests, r.guests, r.status
       FROM reservations r
       JOIN restaurants rest ON rest.id = r.restaurant_id
       WHERE r.user_id = $1`,
      [user.id]
    );
    const sorted = rows.sort((a, b) => new Date(a.reservation_at).getTime() - new Date(b.reservation_at).getTime());
    res.json(sorted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const deleteReservation = async (req: Request, res: Response) => {
  const user = req.user as { id: number; email: string } | undefined;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const id = Number(req.params.id);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT r.restaurant_id, r.requested_guests, r.reservation_at, rest.name AS restaurant_name FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id WHERE r.id = $1 AND r.user_id = $2 FOR UPDATE',
      [id, user.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const { restaurant_id, requested_guests, reservation_at, restaurant_name } = rows[0]; // Changed guests to requested_guests
    await client.query('DELETE FROM reservations WHERE id = $1', [id]);
    await client.query('COMMIT');
    try {
      // Use the new function for sending cancellation email
      await sendReservationCancellationEmail(
        user.email,
        restaurant_name,
        requested_guests, // Changed guests to requested_guests
        new Date(reservation_at).getTime()
      );
    } catch (mailErr) {
      console.error('Mail error', mailErr);
    }
    io.to(`restaurant_${restaurant_id}`).emit('occupancy_update', { restaurant_id });
    res.json({ message: 'Reservation cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};

// Confirm presence endpoint for restaurants
export const confirmPresence = async (req: Request, res: Response) => {
  const user = req.user as any;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const id = Number(req.params.id);
  const { rows } = await db.query(
    'SELECT restaurant_id FROM reservations WHERE id=$1',
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
  const restaurant_id = rows[0].restaurant_id;
  await db.query(
    `UPDATE reservations
     SET presence_confirmed = TRUE,
         presence_confirmed_at = NOW(),
         status = 'confirmed'
     WHERE id = $1`,
    [id]
  );
  io.to(`restaurant_${restaurant_id}`).emit('occupancy_update', { restaurant_id });
  res.json({ message: 'Presence confirmed' });
};
