public decimal CalculateTotal(List<OrderItem> items, Discount discount)
{
    decimal total = 0.0m;
    foreach (OrderItem item in items)
    {
        if (item.Price > 0 && item.Quantity > 0)
        {
            total += item.Price * item.Quantity;
        }
    }
    if (discount != null && discount.IsValid())
    {
        total = discount.Apply(total);
    }
    if (total < 0)
    {
        total = 0.0m;
    }
    return total;
}