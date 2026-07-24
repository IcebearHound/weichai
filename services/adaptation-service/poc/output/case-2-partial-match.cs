public bool ValidateOrder(Order order)
{
    if (order == null)
    {
        throw new ArgumentException("Order cannot be null");
    }
    if (order.Items == null || order.Items.Count == 0)
    {
        throw new ArgumentException("Order must contain at least one item");
    }
    if (order.Customer == null)
    {
        throw new ArgumentException("Order must have a customer");
    }
    return true;
}