[Authorize]
[Route("orders")]
public class OrdersController : Controller
{
    [HttpGet("")]
    public async Task<IActionResult> List() => View();

    [HttpGet("{id:int}")]
    public async Task<IActionResult> Details(int id) => View();

    [AllowAnonymous]
    [HttpGet("track")]
    public IActionResult Track() => View();

    [HttpDelete("{id}")]
    public IActionResult Delete(int id) => Ok();
}
