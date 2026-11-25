import { Router } from 'express';
const orderRoutes = Router();
function listOrders(req, res) { res.json([]); }
orderRoutes.get('/', listOrders);
export default orderRoutes;
