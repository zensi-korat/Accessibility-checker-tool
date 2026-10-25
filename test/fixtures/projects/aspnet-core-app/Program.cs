var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages(o => {
  o.Conventions.AuthorizeFolder("/Admin");
});
