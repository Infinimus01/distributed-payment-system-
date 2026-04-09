const express = require('express');

function createWalletRoutes(walletController) {
    const router = express.Router();

    // Create wallet
    router.post('/create', (req, res, next) => {
        walletController.createWallet(req, res, next);
    });

    // Debit wallet
    router.post('/debit', (req, res, next) => {
        walletController.debitWallet(req, res, next);
    });

    // Credit wallet
    router.post('/credit', (req, res, next) => {
        walletController.creditWallet(req, res, next);
    });

    // Get wallet details
    router.get('/:walletId', (req, res, next) => {
        walletController.getWallet(req, res, next);
    });

    // Get transaction history
    router.get('/:walletId/transactions', (req, res, next) => {
        walletController.getTransactionHistory(req, res, next);
    });

    // Reconcile balance
    router.get('/:walletId/reconcile', (req, res, next) => {
        walletController.reconcileBalance(req, res, next);
    });

    // Verify ledger entry exists — used by ReconciliationService
    router.get('/:walletId/ledger/:ledgerEntryId', (req, res, next) => {
        walletController.verifyLedgerEntry(req, res, next);
    });

    return router;
}

module.exports = createWalletRoutes;
