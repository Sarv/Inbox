/**
 * A reduced but representative Outlook/Word reply: the `<!-- … -->`-wrapped
 * stylesheet, an MSO-only conditional block, a downlevel-revealed block, nested
 * layout tables, a tracking script, entities (`&nbsp;`, `&amp;`, `&lt;…&gt;`),
 * a `<br>` run, mailto and https links and a signature div. The HTML → text
 * converters pin their output on it so a parser swap cannot quietly change what
 * ordinary mail turns into.
 */
export const OUTLOOK_REPLY_HTML = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head>',
  '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
  '<style><!--',
  'p.MsoNormal {margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}',
  'a:link {color:#0563C1; text-decoration:underline;}',
  '--></style>',
  '<!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" /></xml><![endif]-->',
  '</head><body lang="EN-US" link="#0563C1">',
  '<div class="WordSection1">',
  '<p class="MsoNormal">Hi Priya,</p>',
  '<p class="MsoNormal">The quote for <b>Q3&nbsp;renewal</b> is below &amp; the tag is &lt;draft&gt;.</p>',
  '<table border="0" cellpadding="0"><tr><td>',
  '<table><tr><td><b>Item</b></td><td><b>Price</b></td></tr>',
  '<tr><td>Licences</td><td>$1,200</td></tr></table>',
  '</td></tr></table>',
  '<!--[if mso]><p class="MsoNormal">Outlook-only spacer</p><![endif]-->',
  '<!--[if !mso]><!--><p class="MsoNormal">Shown everywhere else</p><!--<![endif]-->',
  '<script type="text/javascript">trackOpen("abc123");</script>',
  '<p class="MsoNormal">Questions? <a href="mailto:ravi@vendor.example">ravi@vendor.example</a>',
  ' or <a href="https://vendor.example/quote/42">the quote page</a>.<br><br><br></p>',
  '<div class="signature">Regards,<br>Ravi Menon<br>Vendor Ltd</div>',
  '</div></body></html>',
].join('\n');
