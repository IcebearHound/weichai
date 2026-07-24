public PaymentResult ProcessPayment(PaymentRequest request)
{
    if (request.Amount <= 0)
    {
        throw new ArgumentException("Payment amount must be positive");
    }
    Account account = accountRepository.FindById(request.AccountId);
    if (account == null)
    {
        throw new ArgumentException("Account not found: " + request.AccountId);
    }
    if (account.Balance < request.Amount)
    {
        throw new InsufficientFundsException(
            string.Format("Balance {0:F2} is insufficient for payment {1:F2}",
                account.Balance, request.Amount)
        );
    }
    try
    {
        PaymentResult result = paymentGateway.Charge(request);
        account.Balance = account.Balance - request.Amount;
        accountRepository.Save(account);
        return result;
    }
    catch (GatewayException e)
    {
        throw new PaymentFailedException("Payment gateway error", e);
    }
}