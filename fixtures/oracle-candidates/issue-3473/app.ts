import express from 'express';
import orders from './orders';
const service = express();
function health(req, res) { res.send('ok'); }
service.get('/health', health);
service.use('/orders', orders);
