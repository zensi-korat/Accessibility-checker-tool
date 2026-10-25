public class ProductsController : Controller
{
    public IActionResult Index() => View();
    public IActionResult Show(int id) => View();
}
