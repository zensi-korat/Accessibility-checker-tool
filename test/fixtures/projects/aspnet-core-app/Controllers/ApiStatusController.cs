[ApiController]
[Route("api/status")]
public class ApiStatusController : ControllerBase
{
    [HttpGet] public IActionResult Get() => Ok();
}
