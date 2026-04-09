const express = require('express');

function createPaymentRoutes(paymentController) {
    const router = express.Router();

    // Create payment
    router.post('/', (req, res, next) => {
        paymentController.createPayment(req, res, next);
    });

    // Process payment (debit wallet)
    router.post('/:paymentId/process', (req, res, next) => {
        paymentController.processPayment(req, res, next);
    });

    // Refund payment (credit wallet)
    router.post('/:paymentId/refund', (req, res, next) => {
        paymentController.refundPayment(req, res, next);
    });

    // Get payment by ID
    router.get('/:paymentId', (req, res, next) => {
        paymentController.getPayment(req, res, next);
    });

    // Get payments by user ID
    router.get('/user/:userId', (req, res, next) => {
        paymentController.getPaymentsByUserId(req, res, next);
    });

    // Reconciliation — detect mismatches between payments and wallet ledger
    router.get('/reconcile/run', (req, res, next) => {
        paymentController.reconcile(req, res, next);
    });

    // Update payment status
    router.patch('/:paymentId/status', (req, res, next) => {
        paymentController.updatePaymentStatus(req, res, next);
    });

    return router;
}

module.exports = createPaymentRoutes;
