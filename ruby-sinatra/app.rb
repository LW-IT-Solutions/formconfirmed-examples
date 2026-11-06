# frozen_string_literal: true

# Contact form protected by formconfirmed - Sinatra.
# GET / shows the form with the widget, POST / checks the token on the server.

require 'fileutils'
require 'json'
require 'sinatra'
require 'time'
require_relative 'formconfirmed'

CFG = Formconfirmed.config
DATA_DIR = ENV['DATA_DIR'].to_s.empty? ? File.join(__dir__, 'data') : ENV['DATA_DIR']

set :bind, ENV.fetch('HOST', '127.0.0.1')
set :port, Integer(ENV.fetch('PORT', '4567'))
# Rack::Protection::HostAuthorization: allow the hosts you serve.
set :host_authorization, { permitted_hosts: ENV.fetch('ALLOWED_HOSTS', '127.0.0.1,localhost').split(',') }

PAGE = <<~ERB
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Contact - formconfirmed Sinatra example</title>
    <script src="<%= h CFG[:api] %>/widget.js" async defer></script>
    <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;box-sizing:border-box}</style>
  </head>
  <body>
    <h1>Contact</h1>
    <% unless @notice.to_s.empty? %><p role="status"><%= h @notice %></p><% end %>
    <form method="post" action="/">
      <label>Name <input name="name" maxlength="60" required></label>
      <label>E-mail <input type="email" name="email" maxlength="80" required></label>
      <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
      <div class="fcp-widget" data-sitekey="<%= h CFG[:sitekey] %>" data-purpose="<%= h Formconfirmed::PURPOSE %>"></div>
      <button type="submit">Send</button>
    </form>
  </body>
  </html>
ERB

helpers do
  # Escape every value that goes into the page.
  def h(text)
    Rack::Utils.escape_html(text.to_s)
  end

  def page(status_code, notice = '')
    @notice = notice
    status status_code
    erb PAGE
  end

  # Appends one message as a JSON line - stands in for sending an e-mail or a moderation queue.
  def store(file, record)
    FileUtils.mkdir_p(DATA_DIR, mode: 0o700)
    line = JSON.generate({ time: Time.now.utc.iso8601 }.merge(record))
    File.open(File.join(DATA_DIR, file), 'a') do |f|
      f.flock(File::LOCK_EX)
      f.puts(line)
    end
  end

  # Hook for an independent check of your own application that may stand in when formconfirmed gave
  # no clear answer - e.g. the visitor is logged in, or a strict CAPTCHA you already run has passed.
  # It must not depend on formconfirmed. Without such a check, return false: the message is held.
  def independent_check_passed?(_form)
    false
  end

  def field(name)
    v = params[name]
    v.is_a?(String) ? v : ''
  end
end

get '/' do
  page(200)
end

post '/' do
  form = { name: field('name').strip, email: field('email').strip, message: field('message').strip }
  limits = { name: 60, email: 80, message: 5000 }
  if limits.any? { |k, max| form[k].empty? || form[k].length > max }
    return page(400, 'Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).')
  end
  return page(400, 'Please enter a valid e-mail address.') unless form[:email].match?(/\A[^\s@]+@[^\s@]+\.[^\s@]+\z/)

  result = Formconfirmed.verify(CFG, {
                                  response: field(Formconfirmed::FIELD),
                                  hp: field(Formconfirmed::HONEYPOT),
                                  remoteip: request.ip.to_s, # behind a proxy: the real visitor address
                                  email: form[:email],
                                  name: form[:name],
                                  content: form[:message]
                                })

  case Formconfirmed.decide(result) { independent_check_passed?(form) }
  when :deliver
    # Send the e-mail here. The example writes the message to data/delivered.jsonl.
    store('delivered.jsonl', form.merge(score: result.score))
    page(200, 'Thank you. Your message has been sent.')
  when :hold
    # HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
    # Keep the message for a human to look at - never deliver it silently.
    store('held.jsonl', form.merge(why: result.unavailable ? 'unavailable' : result.action,
                                   codes: result.codes, reasons: result.reasons))
    page(202, 'Thank you. Your message has been received and will be reviewed before it is processed.')
  else # :reject
    if result.reasons.include?('service_unavailable')
      page(403, 'Your message could not be checked right now. Please try again in a few minutes.')
    else
      page(403, 'Your message could not be sent. Please reload the page and try again.')
    end
  end
end
