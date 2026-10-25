public class HomeController : Controller
{
    public IActionResult Index() => View();

    public IActionResult Contact() => View();

    [HttpPost]
    public IActionResult Contact(ContactForm form) => RedirectToAction("Index");
}
